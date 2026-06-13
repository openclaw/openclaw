// Codex tests cover the run-attempt yield -> paused lifecycle terminal contract.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { testing } from "./run-attempt.js";

type OpenClawCodingToolsFactory = Parameters<
  typeof testing.setOpenClawCodingToolsFactoryForTests
>[0];
type OpenClawCodingToolsOptions = Parameters<OpenClawCodingToolsFactory>[0];
type OpenClawCodingTool = ReturnType<OpenClawCodingToolsFactory>[number];

type LifecycleAgentEvent = {
  stream?: string;
  data?: {
    phase?: string;
    yielded?: boolean;
    livenessState?: string;
    stopReason?: string;
  };
};

function findLifecycleEnd(onAgentEvent: ReturnType<typeof vi.fn>): LifecycleAgentEvent | undefined {
  const events = onAgentEvent.mock.calls.map(([event]) => event) as LifecycleAgentEvent[];
  return events.find((event) => event.stream === "lifecycle" && event.data?.phase === "end");
}

// Stub OpenClaw runtime tool catalog: a single tool whose execute optionally
// triggers the real onYield wiring (dynamic-tool-build.ts onYield -> onYieldDetected),
// which is what flips the run's yieldDetected flag for the terminal projection.
function stubToolsFactory(options: { tool: string; yields: boolean }): OpenClawCodingToolsFactory {
  return ((factoryOptions: OpenClawCodingToolsOptions) => {
    const tool = {
      name: options.tool,
      label: options.tool,
      description: `${options.tool} stub tool`,
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: vi.fn(async () => {
        if (options.yields) {
          await factoryOptions?.onYield?.("proof-yield");
        }
        return {
          content: [{ type: "text" as const, text: "yielded" }],
          details: {},
        };
      }),
    };
    return [tool] as unknown as OpenClawCodingTool[];
  }) as OpenClawCodingToolsFactory;
}

async function driveToolTurn(toolName: string): Promise<ReturnType<typeof vi.fn>> {
  const harness = createStartedThreadHarness();
  const onRunAgentEvent = vi.fn();
  const params = createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace"));
  // Tools must be enabled and a runtime plan present for buildDynamicTools to
  // invoke the injected factory and register the stub tool for this turn.
  params.disableTools = false;
  params.runtimePlan = createCodexRuntimePlanFixture();
  params.onAgentEvent = onRunAgentEvent;

  const run = runCodexAppServerAttempt(params);
  await harness.waitForMethod("thread/start");

  await harness.handleServerRequest({
    id: "request-tool-1",
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: toolName,
      arguments: {},
    },
  });

  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await run;
  return onRunAgentEvent;
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt yield lifecycle", () => {
  it("forwards yielded -> paused on the lifecycle end event when sessions_yield fires", async () => {
    testing.setOpenClawCodingToolsFactoryForTests(
      stubToolsFactory({ tool: "sessions_yield", yields: true }),
    );

    const onRunAgentEvent = await driveToolTurn("sessions_yield");

    const lifecycleEnd = findLifecycleEnd(onRunAgentEvent);
    expect(lifecycleEnd).toBeDefined();
    expect(lifecycleEnd?.data?.yielded).toBe(true);
    expect(lifecycleEnd?.data?.livenessState).toBe("paused");
    expect(lifecycleEnd?.data?.stopReason).toBe("end_turn");
  });

  it("omits yield meta on the lifecycle end event for a normal tool turn", async () => {
    testing.setOpenClawCodingToolsFactoryForTests(
      stubToolsFactory({ tool: "echo", yields: false }),
    );

    const onRunAgentEvent = await driveToolTurn("echo");

    const lifecycleEnd = findLifecycleEnd(onRunAgentEvent);
    expect(lifecycleEnd).toBeDefined();
    expect(lifecycleEnd?.data?.yielded).toBeUndefined();
    expect(lifecycleEnd?.data?.livenessState).toBeUndefined();
    expect(lifecycleEnd?.data?.stopReason).toBeUndefined();
  });
});
