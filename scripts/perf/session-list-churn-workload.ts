import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { controlGatewayProfile, readGatewayResources } from "../lib/gateway-bench-profile.ts";
import { waitForInitialProbe } from "../lib/gateway-bench-runtime.ts";
import type { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

type Peer = ReturnType<typeof createGatewayWsClient>;
type Request = (peer: Peer, method: string, params: unknown, window: string) => Promise<unknown>;

export async function observeSessionListChurnGateway(port: number, output: string) {
  await import("../lib/gateway-bench-profile-preload.ts");
  const loop = monitorEventLoopDelay({ resolution: 10 });
  let cpu = process.threadCpuUsage();
  let started = performance.now();
  const message = (raw: unknown) => {
    if (!isRecord(raw) || raw.channel !== "reconnect-wave" || typeof raw.id !== "string") {
      return;
    }
    if (raw.action === "begin") {
      loop.reset();
      loop.enable();
      cpu = process.threadCpuUsage();
      started = performance.now();
    } else if (raw.action === "end") {
      const used = process.threadCpuUsage(cpu);
      loop.disable();
      writeFileSync(
        path.join(output, `${String(raw.window)}-server.json`),
        JSON.stringify({
          mainThreadCpu: used,
          elapsedMs: performance.now() - started,
          eventLoopP99Ms: loop.percentile(99) / 1e6,
        }),
      );
    } else if (raw.action === "stop") {
      loop.disable();
      process.off("message", message);
    }
    process.send?.({ channel: "reconnect-wave", id: raw.id });
  };
  process.on("message", message);
  void waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 120_000,
  }).then(
    (ready) =>
      process.send?.({
        channel: "reconnect-wave",
        id: "ready",
        ...(ready.status === 200 ? {} : { error: "Gateway admission is not ready" }),
      }),
    (error: unknown) =>
      process.send?.({ channel: "reconnect-wave", id: "ready", error: String(error) }),
  );
}

export async function runSessionListChurnWorkload(params: {
  gateway: ChildProcess;
  readers: Peer[];
  writers: Peer[];
  request: Request;
  command: (child: ChildProcess, body: Record<string, string>) => Promise<unknown>;
  output: string;
  profile: boolean;
  retention: boolean;
}) {
  const { gateway, readers, writers, request, command, output } = params;
  assert.equal(readers.length, 65);
  assert.equal(writers.length, 20);
  const listParams = (index: number) => ({
    agentId: "main",
    rowMode: "sidebar",
    source: "sidebar",
    limit: 100,
    offset: (index % 5) * 100,
    archived: ([false, true, "all"] as const)[index % 3],
    ...(index % 5 === 4 ? { search: "synthetic" } : {}),
    configuredAgentsOnly: true,
    excludeDock: true,
    includeGlobal: true,
    includeUnknown: true,
    includeDerivedTitles: true,
    includeLastMessage: true,
  });
  const count = async (archived: boolean | "all") => {
    const result = await request(
      readers[0]!,
      "sessions.list",
      {
        ...listParams(0),
        archived,
        offset: 0,
        limit: 1,
      },
      "census",
    );
    assert(isRecord(result) && typeof result.totalCount === "number");
    return result.totalCount;
  };
  const total = await count("all");
  const archived = await count(true);
  const active = await count(false);
  console.log(JSON.stringify({ census: { total, archived, active } }));
  assert(total >= 5_000 && total === archived + active, "agent scope must contain >=5000 rows");
  assert(archived / total >= 0.69 && archived / total <= 0.71, "archive fraction must be ~70%");
  await Promise.all(readers.map((peer) => request(peer, "sessions.subscribe", {}, "setup")));
  const quantiles = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b);
    const percentile = (fraction: number) => {
      const position = (sorted.length - 1) * fraction;
      const lower = Math.floor(position);
      return sorted[lower]! + (sorted[Math.ceil(position)]! - sorted[lower]!) * (position - lower);
    };
    return {
      count: sorted.length,
      p50: percentile(0.5),
      p90: percentile(0.9),
      p99: percentile(0.99),
    };
  };
  const run = async (label: string, durationMs: number, append: boolean) => {
    const started = performance.now();
    const samples: number[] = [];
    const completedAt: number[] = [];
    const writtenKeys = new Set<string>();
    const pending = new Set<Promise<void>>();
    let failure: Error | undefined;
    const fail = (error: unknown) => {
      failure ??= error instanceof Error ? error : new Error(String(error));
    };
    const writing = writers
      .map(async (peer, index) => {
        const sessionKey = `agent:main:team-shape-session-${index}`;
        let iteration = 0;
        while (iteration < Math.floor(durationMs / 1000)) {
          if (!append || failure) {
            break;
          }
          const scheduled = started + iteration * 1000;
          if (performance.now() < scheduled) {
            await delay(scheduled - performance.now());
          }
          await request(
            peer,
            "chat.inject",
            {
              sessionKey,
              agentId: "main",
              message: `Synthetic ${label} writer ${index} append ${iteration}`,
            },
            label,
          );
          writtenKeys.add(sessionKey);
          iteration++;
        }
        return iteration;
      })
      .map((job) =>
        job.catch((error: unknown) => {
          fail(error);
          return 0;
        }),
      );
    for (let index = 0; index < Math.round((durationMs * 30) / 1000); index++) {
      if (failure) {
        break;
      }
      const scheduled = started + (index * 1000) / 30;
      if (performance.now() < scheduled) {
        await delay(scheduled - performance.now());
      }
      if (pending.size >= readers.length) {
        await Promise.race(pending);
      }
      const at = performance.now();
      const job = request(
        readers[index % readers.length]!,
        "sessions.list",
        listParams(index),
        label,
      )
        .then(() => {
          samples.push(performance.now() - at);
          completedAt.push(performance.now() - started);
        })
        .catch(fail);
      pending.add(job);
      void job.then(
        () => pending.delete(job),
        () => pending.delete(job),
      );
    }
    const [writes] = await Promise.all([Promise.all(writing), Promise.all(pending)]);
    if (failure !== undefined) {
      throw failure;
    }
    const elapsedMs = performance.now() - started;
    const bins = Array.from(
      { length: Math.floor(durationMs / 5_000) },
      (_, bin) =>
        completedAt.filter((at) => at >= bin * 5_000 && at < (bin + 1) * 5_000).length / 5,
    );
    const listRate = (samples.length * 1000) / elapsedMs;
    const appendCount = writes.reduce((a, b) => a + b, 0);
    const result = {
      label,
      elapsedMs,
      listRate,
      fiveSecondListRates: bins,
      latency: quantiles(samples),
      appendingSessions: writtenKeys.size,
      writes: appendCount,
      appendRate: (appendCount * 1000) / elapsedMs,
    };
    console.log(JSON.stringify({ phase: result }));
    assert(listRate >= 20 && bins.every((rate) => rate >= 20), "sustained list rate below 20/s");
    assert(samples.length === Math.round((durationMs * 30) / 1000), "incomplete list wave");
    assert(
      !append || (writtenKeys.size === 20 && appendCount === 20 * Math.floor(durationMs / 1000)),
      "incomplete append load",
    );
    return result;
  };
  await run("warmup", 20_000, true);
  const waves = [];
  for (let wave = 0; wave < (params.retention ? 5 : 1); wave++) {
    const label = `stress-${wave}`;
    if (params.profile) {
      await controlGatewayProfile(
        gateway,
        "cpu",
        "start",
        path.join(output, `${label}.cpuprofile`),
      );
    }
    await command(gateway, { action: "begin", window: label });
    const result = await run(label, 30_000, true);
    await command(gateway, { action: "end", window: label });
    if (params.profile) {
      await controlGatewayProfile(gateway, "cpu", "stop", path.join(output, `${label}.cpuprofile`));
    }
    if (params.retention) {
      // The shared response owner retains completed replies for five seconds.
      await delay(5100);
      const retained = await readGatewayResources(gateway, { collectGarbage: true });
      writeFileSync(path.join(output, `${label}-retained.json`), JSON.stringify(retained));
    }
    waves.push(result);
  }
  const steady = await run("steady", 10_000, false);
  const result = { census: { total, archived, active }, waves, steady };
  writeFileSync(path.join(output, "stress-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

export async function runColdSessionRead({
  peer,
  index,
  window,
  request,
  modelCatalog,
  timeoutMs,
}: {
  peer: Peer;
  index: number;
  window: string;
  request: Request;
  modelCatalog: Promise<void> | undefined;
  timeoutMs: number;
}) {
  const key = `agent:main:team-shape-session-${index}`;
  const roster = request(peer, "sessions.subscribe", {}, window);
  const list = request(
    peer,
    "sessions.list",
    {
      agentId: "main",
      limit: 200,
      rowMode: "sidebar",
      source: "sidebar",
      configuredAgentsOnly: true,
      excludeDock: true,
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    },
    window,
  );
  const subscribed = request(
    peer,
    "sessions.messages.subscribe",
    { key, includeApprovals: true, subscriptionId: randomUUID() },
    window,
  );
  const catalog = modelCatalog;
  let catalogTimer: ReturnType<typeof setTimeout> | undefined;
  const modelReady = catalog
    ? Promise.race([
        catalog,
        new Promise<never>((_, reject) => {
          catalogTimer = setTimeout(() => reject(new Error("models.snapshot timeout")), timeoutMs);
        }),
      ]).finally(() => clearTimeout(catalogTimer))
    : request(
        peer,
        "models.list",
        { agentId: "main", sessionKey: key, view: "configured" },
        window,
      );
  const results = await Promise.allSettled([
    roster,
    list,
    subscribed,
    request(peer, "sessions.observer.visibility", { visible: true }, window),
    request(peer, "sessions.resolve", { key, agentId: "main" }, window),
    request(peer, "board.get", { sessionKey: key, agentId: "main" }, window),
    request(peer, "agents.list", {}, window),
    request(peer, "users.list", {}, window),
    modelReady,
    subscribed.then(() => request(peer, "chat.startup", { sessionKey: key, limit: 80 }, window)),
  ]);
  return results.every((result) => result.status === "fulfilled");
}
