/**
 * Seam coverage for native compaction: a backend record streamed as JSONL must
 * reach the no-output watchdog through the ordinary event handlers. Nothing here
 * injects a `compactionActive` getter, so the wiring in `executeCliProcess` is
 * the only thing that carries the flag from the stream to the plugin watchdog
 * and into the recorded timeout context.
 */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { CliBackendParseJsonlLifecycleEvent } from "../../plugins/cli-backend.types.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { waitUntilAborted } from "./execute-plugin.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import {
  createManagedRun,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

type SupervisorSpawnInput = Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];

const NO_OUTPUT_TIMEOUT_MS = 1_000;
const COMPACTION_START = { type: "system", subtype: "status", status: "compacting" };
const COMPACTION_END = { compact_result: "success" };
const COMPACTION_FAILED = { compact_result: "failed" };

/** Mirrors the shape a CLI backend plugin projects from its own native records. */
const parseJsonlLifecycleEvent: CliBackendParseJsonlLifecycleEvent = (line) => {
  if (!line.includes("compacting") && !line.includes("compact_result")) {
    return null;
  }
  const record = JSON.parse(line) as Record<string, unknown>;
  if (record.compact_result === "success" || record.compact_result === "failed") {
    return { kind: "compaction", phase: "end", completed: record.compact_result === "success" };
  }
  if (record.type === "system" && record.subtype === "status") {
    return record.status === "compacting" ? { kind: "compaction", phase: "start" } : null;
  }
  return null;
};

function buildCompactionRunContext(runId: string) {
  const context = buildPreparedCliRunContext({
    runId,
    config: { plugins: { enabled: false } },
    timeoutMs: 1_800_000,
    backend: {
      command: process.execPath,
      sessionMode: "none",
      reliability: {
        watchdog: { fresh: { minMs: NO_OUTPUT_TIMEOUT_MS, maxMs: NO_OUTPUT_TIMEOUT_MS } },
      },
    },
  });
  context.backendResolved.bundleMcp = false;
  context.backendResolved.parseJsonlLifecycleEvent = parseJsonlLifecycleEvent;
  return context;
}

function useWatchdogTimers() {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
}

afterEach(() => {
  supervisorSpawnMock.mockReset();
  vi.useRealTimers();
});

it("defers the no-output watchdog while a streamed compaction record is active", async () => {
  useWatchdogTimers();
  const context = buildCompactionRunContext("compaction-seam-defer");
  const compactionStarted = createDeferred();
  const compactionFinished = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute() {
      yield COMPACTION_START;
      compactionStarted.resolve();
      await compactionFinished.promise;
      yield COMPACTION_END;
      yield { type: "result", subtype: "success", result: "compaction survived" };
    },
  };
  let settled = false;
  const run = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context).finally(() => {
    settled = true;
  });
  try {
    await compactionStarted.promise;
    await vi.advanceTimersByTimeAsync(NO_OUTPUT_TIMEOUT_MS * 30);
    expect(settled).toBe(false);

    compactionFinished.resolve();
    await expect(run).resolves.toMatchObject({ text: "compaction survived" });
  } finally {
    compactionFinished.resolve();
    await Promise.allSettled([run]);
  }
});

it("re-arms the no-output watchdog once the streamed compaction record ends", async () => {
  useWatchdogTimers();
  const context = buildCompactionRunContext("compaction-seam-rearm");
  const compactionEnded = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute(execution) {
      yield COMPACTION_START;
      yield COMPACTION_END;
      compactionEnded.resolve();
      // The turn goes silent with nothing outstanding; a finished compaction
      // must not grant permanent immunity from the ordinary watchdog.
      await waitUntilAborted(execution);
      yield { type: "result", subtype: "success", result: "unreachable" };
    },
  };
  const run = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context);
  const rejection = expect(run).rejects.toThrow("produced no output");

  await compactionEnded.promise;
  await vi.advanceTimersByTimeAsync(NO_OUTPUT_TIMEOUT_MS * 2);

  await rejection;
});

it("re-arms the no-output watchdog when the streamed compaction record fails", async () => {
  useWatchdogTimers();
  const context = buildCompactionRunContext("compaction-seam-rearm-failed");
  const compactionEnded = createDeferred();
  context.executionTarget = {
    kind: "plugin",
    async *execute(execution) {
      yield COMPACTION_START;
      yield COMPACTION_FAILED;
      compactionEnded.resolve();
      // A compaction that ends in failure still ends. Treating only a
      // successful result as an end would latch the defer on forever.
      await waitUntilAborted(execution);
      yield { type: "result", subtype: "success", result: "unreachable" };
    },
  };
  const run = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context);
  const rejection = expect(run).rejects.toThrow("produced no output");

  await compactionEnded.promise;
  await vi.advanceTimersByTimeAsync(NO_OUTPUT_TIMEOUT_MS * 2);

  await rejection;
});

it("records streamed compaction on a supervised no-output timeout", async () => {
  const context = buildCompactionRunContext("compaction-seam-supervised");
  const stdout = `${JSON.stringify(COMPACTION_START)}\n`;
  supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
    const input = args[0] as SupervisorSpawnInput;
    input.onStdout?.(stdout);
    return createManagedRun({
      reason: "no-output-timeout",
      exitCode: null,
      exitSignal: "SIGKILL",
      durationMs: 1_000,
      stdout: input.captureOutput === false ? "" : stdout,
      stderr: "",
      timedOut: true,
      noOutputTimedOut: true,
    });
  });

  // The supervisor owns this watchdog and has already killed the child, so the
  // run still fails; the recorded context must not claim the CLI was idle.
  await expect(
    wrapPreparedCliRunWithTestAdmission(executePreparedCliRun)(context),
  ).rejects.toMatchObject({
    name: "FailoverError",
    cliTimeout: { mode: "no-output", compactionActive: true },
  });
});
