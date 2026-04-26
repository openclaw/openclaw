import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptResult } from "../pi-embedded-runner/run/types.js";
import {
  createPiAgentHarness,
  createPiAgentHarnessV2,
  PI_AGENT_HARNESS_ID,
  PI_AGENT_HARNESS_LABEL,
} from "./builtin-pi.js";
import type { AgentHarness, AgentHarnessAttemptParams } from "./types.js";
import { getNativeAgentHarnessV2Factory } from "./v2.js";

function createAttemptParams(): AgentHarnessAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "session-key",
    runId: "run-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: { id: "gpt-5.4", provider: "codex" } as Model<Api>,
    authStorage: {} as never,
    modelRegistry: {} as never,
    thinkLevel: "low",
    messageChannel: "qa",
    trigger: "manual",
  } as AgentHarnessAttemptParams;
}

function createAttemptResult(): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: "session-1",
    messagesSnapshot: [],
    assistantTexts: ["pi ok"],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  } as EmbeddedRunAttemptResult;
}

describe("built-in PI agent harness", () => {
  it("registers a native AgentHarnessV2 factory under the 'pi' harness id at module load", () => {
    expect(getNativeAgentHarnessV2Factory(PI_AGENT_HARNESS_ID)).toBeDefined();
  });

  it("createPiAgentHarness returns the canonical PI V1 harness shape", () => {
    const harness = createPiAgentHarness();
    expect(harness.id).toBe(PI_AGENT_HARNESS_ID);
    expect(harness.label).toBe(PI_AGENT_HARNESS_LABEL);
    expect(harness.supports({ provider: "codex", requestedRuntime: "auto" })).toEqual({
      supported: true,
      priority: 0,
    });
  });

  it("createPiAgentHarnessV2 routes send through the V1 harness runAttempt so PR 4 can plumb split lifecycle without breaking parity", async () => {
    const params = createAttemptParams();
    const result = createAttemptResult();
    const runAttempt = vi.fn(async () => result);
    const v1: AgentHarness = {
      id: PI_AGENT_HARNESS_ID,
      label: PI_AGENT_HARNESS_LABEL,
      supports: () => ({ supported: true, priority: 0 }),
      runAttempt,
    };

    const v2 = createPiAgentHarnessV2(v1);
    const session = await v2.start(await v2.prepare(params));

    expect(await v2.send(session)).toBe(result);
    expect(runAttempt).toHaveBeenCalledWith(params);
  });

  it("createPiAgentHarnessV2 cleanup is intentionally empty at PR 2 to keep parity with the V1 adapter", async () => {
    const v1: AgentHarness = {
      id: PI_AGENT_HARNESS_ID,
      label: PI_AGENT_HARNESS_LABEL,
      supports: () => ({ supported: true, priority: 0 }),
      runAttempt: vi.fn(async () => createAttemptResult()),
    };

    const v2 = createPiAgentHarnessV2(v1);
    const session = await v2.start(await v2.prepare(createAttemptParams()));

    // No-op cleanup must resolve without throwing for both success and error
    // shapes. PR 4 will replace this with split-lifecycle teardown.
    await expect(v2.cleanup({ session, result: createAttemptResult() })).resolves.toBeUndefined();
    await expect(v2.cleanup({ session, error: new Error("boom") })).resolves.toBeUndefined();
  });
});
