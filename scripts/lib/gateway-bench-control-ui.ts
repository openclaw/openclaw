import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { stopChild } from "./gateway-bench-child.ts";
import {
  summarizeControlUiRequests,
  type ControlUiRequestMeasurement,
} from "./gateway-bench-control-ui-correlation.ts";
import type {
  ControlUiDriverResult,
  ControlUiDriverSetup,
} from "./gateway-bench-control-ui-driver.ts";
import type { createGatewayLoadResources } from "./gateway-bench-load-resources.ts";

export type ControlUiLoadOptions = {
  totalClients: number;
  activeClients: number;
  drivers: number;
  durationMs: number;
  timeoutMs: number;
};

export function controlUiClockAligned(durationMs: number, offsets: readonly number[]): boolean {
  return offsets.every(
    (offset) => Number.isFinite(offset) && Math.abs(offset) <= Math.min(50, durationMs / 100),
  );
}

/** A torn final journal line is explicit partial evidence, never a successful result. */
export function parseControlUiJournal(text: string, startNs: string | null) {
  const rows = new Map<string, ControlUiRequestMeasurement>();
  const errors: string[] = [];
  const streams: Array<{ sessionKey: string; runId: string; firstDeltaMs: number }> = [];
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "request") {
        rows.set(entry.request.requestId, entry.request);
      }
      if (entry.type === "delta") {
        streams.push({
          sessionKey: entry.sessionKey,
          runId: entry.runId,
          firstDeltaMs: entry.firstDeltaMs,
        });
      }
      if (entry.type === "error") {
        errors.push(String(entry.error));
      }
    } catch {
      errors.push("Incomplete driver journal record");
    }
  }
  const startMs = startNs === null ? Infinity : Number(BigInt(startNs)) / 1e6;
  const requests = [...rows.values()]
    .filter((row) => row.sentMs >= startMs)
    .map((row) =>
      Object.assign({}, row, {
        sentMs: row.sentMs - startMs,
        ackMs: row.ackMs === null ? null : row.ackMs - startMs,
        firstDeltaMs: row.firstDeltaMs === null ? null : row.firstDeltaMs - startMs,
        finalMs: row.finalMs === null ? null : row.finalMs - startMs,
      }),
    );
  return {
    requests,
    errors,
    streams: streams
      .filter((stream) => stream.firstDeltaMs >= startMs)
      .map((stream) => ({
        sessionKey: stream.sessionKey,
        runId: stream.runId,
        firstDeltaMs: stream.firstDeltaMs - startMs,
      })),
  };
}

function readControlUiJournal(file: string, startNs: string | null) {
  try {
    return parseControlUiJournal(readFileSync(file, "utf8"), startNs);
  } catch {
    return { requests: [], streams: [], errors: ["Driver journal unavailable"] };
  }
}

export async function runControlUiLoad(
  options: ControlUiLoadOptions & {
    port: number;
    protocolVersion: number;
    token: string;
    journalDir: string;
    gatewayPid: number;
    signal?: AbortSignal;
    resources: ReturnType<typeof createGatewayLoadResources>;
  },
) {
  const errors: string[] = [];
  const cancel = Promise.withResolvers<never>();
  void cancel.promise.catch(() => {});
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    cancel.reject(new Error(message));
  };
  const onAbort = () => fail(options.signal?.reason ?? "Control UI load cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const bounded = async <T>(work: Promise<T>, ms: number) => {
    const timer = setTimeout(() => fail(new Error("Control UI phase deadline exceeded")), ms);
    timers.add(timer);
    try {
      return await Promise.race([work, cancel.promise]);
    } finally {
      clearTimeout(timer);
      timers.delete(timer);
    }
  };
  const send = (child: ChildProcess, value: object) =>
    new Promise<void>((resolve, reject) => {
      if (!child.connected) {
        reject(new Error("Driver IPC disconnected"));
        return;
      }
      const timer = setTimeout(
        () => reject(new Error("Driver IPC send timed out")),
        options.timeoutMs,
      );
      child.send(value, (error) => {
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  const owned: Array<{
    child: ChildProcess;
    indices: number[];
    journal: string;
    ready: ReturnType<typeof Promise.withResolvers<unknown>>;
    drained: ReturnType<typeof Promise.withResolvers<unknown>>;
    result: ReturnType<typeof Promise.withResolvers<ControlUiDriverResult>>;
    exit: ReturnType<typeof Promise.withResolvers<void>>;
    phase: "setup" | "ready" | "drained" | "finished";
    resultValue?: ControlUiDriverResult;
  }> = [];
  type Sample = ReturnType<typeof options.resources.read>;
  let after: Sample | null = null;
  let windowBefore: Sample | null = null;
  let windowAfter: Sample | null = null;
  let startNs: string | null = null;
  let startEpochMs: number | null = null;
  let cleaning = false;
  const placement: unknown[] = [];
  const exits: unknown[] = [];
  try {
    options.signal?.throwIfAborted();
    for (let index = 0; index < options.drivers; index++) {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./gateway-bench-control-ui-driver.ts", import.meta.url))],
        {
          detached: process.platform !== "win32",
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
        },
      );
      const state: (typeof owned)[number] = {
        child,
        indices: Array.from({ length: options.totalClients }, (_, i) => i).filter(
          (i) => i % options.drivers === index,
        ),
        journal: path.join(options.journalDir, `driver-${index}.jsonl`),
        ready: Promise.withResolvers(),
        drained: Promise.withResolvers(),
        result: Promise.withResolvers(),
        exit: Promise.withResolvers(),
        phase: "setup",
      };
      owned.push(state);
      child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
      child.on("error", fail);
      child.on("exit", (code, signal) => {
        state.exit.resolve();
        if (!cleaning && (state.phase !== "finished" || code !== 0 || signal !== null)) {
          fail(new Error(`Driver ${index} exited before clean completion: ${code}/${signal}`));
        }
      });
      child.on("message", (value: unknown) => {
        if (!isRecord(value)) {
          fail(new Error("Malformed driver message"));
          return;
        }
        if (value.type === "error") {
          fail(new Error(`Driver ${index}: ${String(value.error)}`));
          return;
        }
        if (!["ready", "drained", "result"].includes(String(value.type))) {
          fail(new Error("Unexpected driver message"));
          return;
        }
        const counts = value.counts;
        const expectedActive = state.indices.filter((i) => i < options.activeClients).length;
        if (
          !isRecord(counts) ||
          counts.connected !== state.indices.length ||
          counts.subscribed !== state.indices.length ||
          counts.active !== expectedActive ||
          JSON.stringify(value.clientIndices) !== JSON.stringify(state.indices)
        ) {
          fail(new Error(`Driver ${index} client/subscription counts differ`));
        }
        if (value.type === "ready" && state.phase === "setup") {
          state.phase = "ready";
          placement.push(value);
          state.ready.resolve(value);
        } else if (value.type === "drained" && state.phase === "ready") {
          state.phase = "drained";
          state.drained.resolve(value);
        } else if (value.type === "result") {
          state.resultValue = value as ControlUiDriverResult;
          if (state.phase !== "drained" && !cleaning) {
            fail(new Error("Driver result arrived before drain"));
          }
          state.phase = "finished";
          state.result.resolve(state.resultValue);
        } else {
          fail(new Error("Duplicate or out-of-order driver phase"));
        }
      });
      const setup: ControlUiDriverSetup = {
        type: "setup",
        port: options.port,
        protocolVersion: options.protocolVersion,
        token: options.token,
        clientIndices: state.indices,
        activeClients: options.activeClients,
        requestTimeoutMs: options.timeoutMs,
        journalPath: state.journal,
      };
      await bounded(send(child, setup), options.timeoutMs);
      // Materialize the fresh shared agent store before other setup lanes enter it.
      if (index === 0) {
        await bounded(state.ready.promise, options.timeoutMs);
      }
    }
    await bounded(Promise.all(owned.map((s) => s.ready.promise)), options.timeoutMs);
    const readyResources = options.resources.read();
    if (!readyResources.pids.includes(options.gatewayPid)) {
      throw new Error("Gateway cgroup admission missing");
    }
    const start = process.hrtime.bigint() + 100_000_000n;
    startNs = String(start);
    startEpochMs =
      performance.timeOrigin + performance.now() + Number(start - process.hrtime.bigint()) / 1e6;
    const sampleAt = (at: bigint) =>
      new Promise<Sample>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            try {
              resolve(options.resources.read());
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
              fail(error);
            }
          },
          Math.max(0, Number(at - process.hrtime.bigint()) / 1e6),
        );
        timers.add(timer);
      });
    const window = Promise.all([
      sampleAt(start),
      sampleAt(start + BigInt(options.durationMs) * 1_000_000n),
    ]);
    void window.catch(() => {});
    await bounded(
      Promise.all(
        owned.map((s) => send(s.child, { type: "start", startNs, durationMs: options.durationMs })),
      ),
      options.timeoutMs,
    );
    await bounded(
      Promise.all(owned.map((s) => s.drained.promise)),
      options.durationMs + options.timeoutMs,
    );
    after = options.resources.read();
    [windowBefore, windowAfter] = await bounded(window, options.timeoutMs);
    await bounded(
      Promise.all(owned.map((s) => send(s.child, { type: "finish" }))),
      options.timeoutMs,
    );
    await bounded(Promise.all(owned.map((s) => s.result.promise)), options.timeoutMs);
    await bounded(Promise.all(owned.map((s) => s.exit.promise)), options.timeoutMs);
  } catch (error) {
    fail(error);
  } finally {
    cleaning = true;
    options.signal?.removeEventListener("abort", onAbort);
    for (const timer of timers) {
      clearTimeout(timer);
    }
    for (const state of owned) {
      if (state.child.connected) {
        await send(state.child, { type: "stop" }).catch(fail);
      }
      exits.push(
        await stopChild(state.child, { onForceKill: () => errors.push("Forced driver cleanup") }),
      );
    }
  }
  const journals = owned.map((state) => readControlUiJournal(state.journal, startNs));
  const requests = owned.flatMap((state, index) => {
    const partial = journals[index]!;
    errors.push(...partial.errors);
    return state.resultValue?.requests ?? partial.requests;
  });
  const summary = summarizeControlUiRequests(requests, options.durationMs, options.activeClients);
  const completed = summary.replies + summary.drainedReplies;
  const cpu =
    windowBefore && after
      ? {
          scope: "gateway-cgroup-including-exited-descendants",
          before: windowBefore,
          after,
          cpuMs: (after.cpuUs - windowBefore.cpuUs) / 1000,
          msPerCompletedReply:
            completed > 0 ? (after.cpuUs - windowBefore.cpuUs) / 1000 / completed : null,
        }
      : null;
  const windowCpu =
    windowBefore && windowAfter && startNs
      ? {
          before: windowBefore,
          after: windowAfter,
          cpuMs: (windowAfter.cpuUs - windowBefore.cpuUs) / 1000,
          msPerReply:
            summary.replies > 0
              ? (windowAfter.cpuUs - windowBefore.cpuUs) / 1000 / summary.replies
              : null,
          startSkewMs: windowBefore.atMs - Number(BigInt(startNs)) / 1e6,
          endSkewMs: windowAfter.atMs - Number(BigInt(startNs)) / 1e6 - options.durationMs,
        }
      : null;
  const driverResults = owned.map((s) => {
    if (!s.resultValue) {
      return null;
    }
    const { requests: _requests, ...result } = s.resultValue;
    return result;
  });
  if (
    windowCpu &&
    !controlUiClockAligned(options.durationMs, [
      windowCpu.startSkewMs,
      windowCpu.endSkewMs,
      ...driverResults.flatMap((result) => (result ? [result.startLagMs] : [])),
    ])
  ) {
    errors.push("Driver or CPU boundary skew exceeds 1% of the window or 50 ms");
  }
  return {
    mode: "control-ui" as const,
    topology: "one-selected-session-per-client" as const,
    totalClients: options.totalClients,
    activeClients: options.activeClients,
    drivers: options.drivers,
    durationMs: options.durationMs,
    startNs,
    startEpochMs,
    placement,
    streamObservations: journals.flatMap((journal) => journal.streams),
    requests,
    summary,
    cpu,
    windowCpu,
    driverResults,
    exits,
    errors,
    valid:
      errors.length === 0 &&
      summary.missingActiveClients.length === 0 &&
      driverResults.every(
        (r) => r && r.error === null && r.forcedClientClose === 0 && !r.partial,
      ) &&
      summary.errors === 0 &&
      summary.pending === 0 &&
      completed > 0 &&
      summary.firstDeltaMs?.count === completed &&
      windowCpu !== null &&
      cpu !== null,
  };
}
