import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as decisionRuntime from "../../../decisions/runtime.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../../logging/diagnostic-session-state.js";
import { recordLoopOutcome } from "../../agent-tools.before-tool-call.diagnostics.js";
import type { HookContext } from "../../agent-tools.before-tool-call.types.js";
import { admitToolCallBatch } from "../../tool-loop-admission.js";
import { createRunToolOutcomeState } from "./tool-outcome-state.js";

let evaluateDecisionSpy: MockInstance<typeof decisionRuntime.evaluateDecision>;

const repeatedArgs = { path: "/synthetic/repeated" };
const repeatedResult = {
  content: [{ type: "text", text: "unchanged" }],
  details: { source: "fixture" },
};

function configWithDecisionModel(
  decisionModel: string | undefined,
  consent: boolean | undefined = true,
): OpenClawConfig {
  return {
    agents: {
      defaults: { decisionModel, experimental: { decisionAssistance: consent } },
    },
    tools: { loopDetection: { enabled: true, semanticNoProgress: "shadow" } },
  };
}

function createState(config: OpenClawConfig, agentId = "main") {
  return createRunToolOutcomeState({
    config,
    agentId,
    signal: new AbortController().signal,
    laneTaskAbortController: new AbortController(),
    assertAdmittedActive: vi.fn(),
    goal: "Finish without repeating unchanged reads",
  });
}

async function driveRepeatedResults(params: {
  config: OpenClawConfig;
  agentId?: string;
  state: ReturnType<typeof createState>;
}) {
  const agentId = params.agentId ?? "main";
  const sessionKey = `semantic-no-progress-${agentId}`;
  const runId = `run-${agentId}`;
  const ctx: HookContext = {
    agentId,
    sessionKey,
    sessionId: sessionKey,
    runId,
    loopDetection: params.state.resolvedLoopDetectionConfig,
    semanticNoProgressObserver: params.state.semanticNoProgressObserver,
  };
  const warningCounts: number[] = [];

  for (let index = 0; index < 20; index += 1) {
    const toolCallId = `repeat-${index}`;
    const candidate = {
      toolCall: {
        type: "toolCall" as const,
        id: toolCallId,
        name: "read",
        arguments: repeatedArgs,
      },
      args: repeatedArgs,
    };
    const admission = await admitToolCallBatch([candidate], ctx);
    if (admission.warnings?.[0]) {
      warningCounts.push(admission.warnings[0].count);
    }
    expect(admission.intervention).toBeUndefined();
    admission.commitReadyCalls?.([{ toolCallId, args: repeatedArgs }]);
    await recordLoopOutcome({
      ctx,
      toolName: "read",
      toolParams: repeatedArgs,
      toolCallId,
      result: repeatedResult,
      toolCallOrdinal: index + 1,
    });
  }

  const critical = await admitToolCallBatch(
    [
      {
        toolCall: {
          type: "toolCall" as const,
          id: "critical",
          name: "read",
          arguments: repeatedArgs,
        },
        args: repeatedArgs,
      },
    ],
    ctx,
  );
  const history = getDiagnosticSessionState({
    sessionKey,
    sessionId: sessionKey,
  }).toolCallHistory;
  return { critical, history, warningCounts };
}

describe("run-owned semantic no-progress observation", () => {
  afterEach(() => clearRuntimeConfigSnapshot());

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    resetDiagnosticSessionStateForTest();
    vi.restoreAllMocks();
    evaluateDecisionSpy = vi.spyOn(decisionRuntime, "evaluateDecision");
  });

  it.each([
    [
      "Labs omitted with a selected model",
      {
        ...configWithDecisionModel("fixture/judge"),
        agents: { defaults: { decisionModel: "fixture/judge" } },
      },
      "main",
    ],
    ["Labs off with a selected model", configWithDecisionModel("fixture/judge", false), "main"],
    ["Labs off without a model", configWithDecisionModel(undefined, false), "main"],
    ["an absent global decision model", configWithDecisionModel(undefined), "main"],
    [
      "an empty owning-agent override",
      {
        ...configWithDecisionModel("fixture/judge"),
        agents: {
          defaults: { decisionModel: "fixture/judge", experimental: { decisionAssistance: true } },
          entries: { worker: { decisionModel: "" } },
        },
      } satisfies OpenClawConfig,
      "worker",
    ],
  ])("preserves deterministic loop behavior with %s", async (_label, config, agentId) => {
    const state = createState(config, agentId);

    expect(state.semanticNoProgressObserver).toBeUndefined();
    const originalResult = structuredClone(repeatedResult);
    const result = await driveRepeatedResults({ config, agentId, state });

    expect(repeatedResult).toEqual(originalResult);
    expect(result.warningCounts).toEqual([10]);
    expect(result.history).toHaveLength(21);
    expect(result.history?.slice(0, 20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "read", resultHash: expect.any(String) }),
      ]),
    );
    expect(new Set(result.history?.slice(0, 20).map((entry) => entry.resultHash)).size).toBe(1);
    expect(result.history?.at(-1)).toMatchObject({ outcomeKind: "tool-loop-veto" });
    expect(result.critical.intervention).toMatchObject({
      kind: "critical-tool-loop",
      detector: "generic_repeat",
      count: 20,
    });
    expect(evaluateDecisionSpy).not.toHaveBeenCalled();
  });

  it.each(["labs", "mode", "disabled", "model"] as const)(
    "stops a prepared observer after published %s opt-out",
    async (control) => {
      const config = configWithDecisionModel("fixture/judge");
      setRuntimeConfigSnapshot(config);
      const state = createState(config);
      expect(state.semanticNoProgressObserver).toBeDefined();
      const disabled = configWithDecisionModel(
        control === "model" ? "fixture/next" : "fixture/judge",
        control !== "labs",
      );
      if (control !== "labs") {
        disabled.tools = {
          loopDetection: {
            enabled: control !== "disabled",
            semanticNoProgress: control === "mode" ? "off" : "shadow",
          },
        };
      }
      setRuntimeConfigSnapshot(disabled);
      const result = await driveRepeatedResults({ config, state });
      expect(result.warningCounts).toEqual([10]);
      expect(result.critical.intervention).toMatchObject({ kind: "critical-tool-loop" });
      expect(evaluateDecisionSpy).not.toHaveBeenCalled();
      expect(state.semanticNoProgressObserver?.snapshot().trajectoryVersion).toBe(0);
      await state.semanticNoProgressObserver?.close();
    },
  );

  it("retires a verdict after a brief published opt-out between observer reads", async () => {
    evaluateDecisionSpy.mockResolvedValue({
      status: "ok",
      provenance: {
        providerId: "fixture",
        rubricVersion: "semantic-no-progress-shadow-v1",
        runtimeGeneration: "fixture",
      },
      result: {
        model: "fixture/judge",
        answers: {
          verdict: { type: "choice", choice: "stalled", probabilities: { stalled: 1 } },
        },
      },
    });
    const config = configWithDecisionModel("fixture/judge");
    setRuntimeConfigSnapshot(config);
    const state = createState(config);
    await state.semanticNoProgressObserver?.observeOutcome({
      toolName: "read",
      toolParams: repeatedArgs,
      result: repeatedResult,
      evidence: { detector: "generic_repeat", level: "warning", count: 10 },
    });
    expect(state.semanticNoProgressObserver?.snapshot().latestJudgment?.verdict).toBe("stalled");

    setRuntimeConfigSnapshot(configWithDecisionModel("fixture/judge", false));
    setRuntimeConfigSnapshot(config);
    expect(state.semanticNoProgressObserver?.snapshot().latestJudgment).toBeUndefined();
    expect(state.semanticNoProgressObserver?.snapshot().trajectoryVersion).toBeGreaterThan(0);
    await state.semanticNoProgressObserver?.close();
  });

  it("keeps a stalled shadow verdict non-authoritative at the critical loop boundary", async () => {
    evaluateDecisionSpy.mockResolvedValue({
      status: "ok",
      provenance: {
        providerId: "fixture",
        rubricVersion: "semantic-no-progress-shadow-v1",
        runtimeGeneration: "fixture",
      },
      result: {
        model: "fixture/judge",
        answers: {
          verdict: { type: "choice", choice: "stalled", probabilities: { stalled: 1 } },
        },
      },
    });
    const config = configWithDecisionModel("fixture/judge");
    const state = createState(config);

    const result = await driveRepeatedResults({ config, state });

    expect(evaluateDecisionSpy).toHaveBeenCalled();
    expect(state.semanticNoProgressObserver?.snapshot().latestJudgment?.verdict).toBe("stalled");
    expect(result.warningCounts).toEqual([10]);
    expect(result.critical.intervention).toMatchObject({
      kind: "critical-tool-loop",
      detector: "generic_repeat",
      count: 20,
    });
    await state.semanticNoProgressObserver?.close();
  });
});
