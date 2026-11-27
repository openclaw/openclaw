import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { BLOCKED_TOOL_CALL_ABORT_FLOOR_MS as WORK_GRACE_MS } from "../../logging/diagnostic-run-activity.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { hasModelFallbackStop } from "../failover-error.js";
import { waitUntilAborted } from "./execute-plugin.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import {
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const NO_OUTPUT_MS = 1_000;
const RUN_TIMEOUT_MS = 60_000;
const TOOL = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "sleep 2400" } }],
  },
};
const execute = wrapPreparedCliRunWithTestAdmission(executePreparedCliRun);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
});
afterEach(() => {
  supervisorSpawnMock.mockReset();
  vi.useRealTimers();
});

it.each([
  { mode: "no-output", startsTool: true, stopsFallback: true },
  { mode: "no-output", startsTool: false, stopsFallback: false },
  // An idle turn always reaches the no-output watchdog first: it stays below the run deadline.
  { mode: "overall", startsTool: true, stopsFallback: true },
] as const)(
  "$mode timeout, tool started: $startsTool -> fallback stopped: $stopsFallback",
  async ({ mode, startsTool, stopsFallback }) => {
    const noOutputMs = mode === "overall" ? 3_600_000 : NO_OUTPUT_MS;
    const started = createDeferred();
    const context = buildPreparedCliRunContext({
      runId: `timeout-${mode}-${startsTool}`,
      model: "fixture-model",
      config: { plugins: { enabled: false } },
      // The other deadline stays out of reach, so only the one under test fires.
      timeoutMs: mode === "overall" ? RUN_TIMEOUT_MS : 3_600_000,
      backend: {
        command: process.execPath,
        sessionMode: "none",
        reliability: {
          watchdog: {
            fresh: { minMs: noOutputMs, maxMs: noOutputMs },
          },
        },
      },
    });
    context.backendResolved.bundleMcp = false;
    context.executionTarget = {
      kind: "plugin",
      async *execute(execution) {
        if (startsTool) {
          // The tool never answers, as when the CLI hangs inside a long exec call.
          yield TOOL;
        }
        started.resolve();
        await waitUntilAborted(execution);
      },
    };
    const run = execute(context).catch((error: unknown) => error);
    await started.promise;
    await vi.advanceTimersByTimeAsync(WORK_GRACE_MS + RUN_TIMEOUT_MS);
    const failure = await run;
    expect(failure).toMatchObject({ name: "FailoverError", cliTimeout: { mode } });
    // Another model would get the same prompt and run the task, and its tools, again (#203465).
    expect(hasModelFallbackStop(failure)).toBe(stopsFallback);
  },
);
