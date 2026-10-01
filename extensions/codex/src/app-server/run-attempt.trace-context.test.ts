// Codex tests cover diagnostic trace propagation into native app-server requests.
import path from "node:path";
import {
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  runWithDiagnosticTraceContext,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createStartedThreadHarness,
  createCodexRuntimePlanFixture,
  createParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

const diagnosticTrace = {
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  traceFlags: "01",
};

function readRequestOptions(
  request: ReturnType<typeof createStartedThreadHarness>["request"],
  method: string,
): { trace?: { traceparent?: string } } | undefined {
  return request.mock.calls.find(([candidate]) => candidate === method)?.[2] as
    | { trace?: { traceparent?: string } }
    | undefined;
}

describe("Codex app-server diagnostic trace context", () => {
  it.each([
    { supplied: true, label: "enriches" },
    { supplied: false, label: "withholds" },
  ])("$label source context using only the admitted run trace", async ({ supplied }) => {
    const beforePromptBuild = vi.fn((_event: unknown, context: unknown) => {
      if (
        !context ||
        typeof context !== "object" ||
        !("trace" in context) ||
        !context.trace ||
        !("trigger" in context) ||
        context.trigger !== "cron" ||
        !("runId" in context) ||
        typeof context.runId !== "string"
      ) {
        return undefined;
      }
      return { appendContext: `Claimed Business refs for ${context.runId}` };
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_prompt_build", handler: beforePromptBuild }]),
    );
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, `source-trace-${supplied}.jsonl`),
      path.join(tempDir, `workspace-source-trace-${supplied}`),
    );
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.trigger = "cron";
    params.diagnosticTrace = supplied ? diagnosticTrace : undefined;
    const run = runCodexAppServerAttempt(params);
    await Promise.race([
      harness.waitForMethod("turn/start"),
      run.then(() => {
        throw new Error("Attempt ended before turn/start");
      }),
    ]);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    expect(beforePromptBuild).toHaveBeenCalledOnce();
    const hookContext = beforePromptBuild.mock.calls[0]?.[1];
    const turnStart = harness.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
    if (supplied) {
      expect(hookContext).toHaveProperty("trace", diagnosticTrace);
      expect(JSON.stringify(turnStart)).toContain(`Claimed Business refs for ${params.runId}`);
    } else {
      expect(hookContext).not.toHaveProperty("trace");
      expect(JSON.stringify(turnStart)).not.toContain("Claimed Business refs");
    }
  });

  it.each([
    { enabled: true, label: "propagates" },
    { enabled: false, label: "omits" },
  ])("$label trace context when diagnostics enabled=$enabled", async ({ enabled }) => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, `trace-${enabled}.jsonl`),
      path.join(tempDir, `workspace-trace-${enabled}`),
    );
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.diagnosticTrace = diagnosticTrace;
    params.config = { diagnostics: { enabled } } as never;

    const run = runWithDiagnosticTraceContext(diagnosticTrace, () =>
      runCodexAppServerAttempt(params),
    );
    await Promise.race([
      harness.waitForMethod("turn/start"),
      run.then((result) => {
        throw new Error(`Attempt ended before turn/start: ${JSON.stringify(result)}`);
      }),
    ]);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const threadStart = readRequestOptions(harness.request, "thread/start");
    const turnStart = readRequestOptions(harness.request, "turn/start");
    if (!enabled) {
      expect(threadStart).not.toHaveProperty("trace");
      expect(turnStart).not.toHaveProperty("trace");
      return;
    }
    expect(threadStart?.trace?.traceparent).toBe(
      "00-11111111111111111111111111111111-2222222222222222-01",
    );
    expect(turnStart?.trace?.traceparent).toMatch(
      /^00-11111111111111111111111111111111-[0-9a-f]{16}-01$/u,
    );
  });
});
