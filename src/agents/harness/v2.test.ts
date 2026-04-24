import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptResult } from "../pi-embedded-runner/run/types.js";
import type { AgentHarness, AgentHarnessAttemptParams } from "./types.js";
import { adaptAgentHarnessToV2 } from "./v2.js";

function createAttemptParams(): AgentHarnessAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
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
    assistantTexts: ["ok"],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}

describe("AgentHarness V2 compatibility adapter", () => {
  it("runs a V1 harness through prepare/start/send without changing attempt params", async () => {
    const params = createAttemptParams();
    const result = createAttemptResult();
    const runAttempt = vi.fn(async () => result);
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      pluginId: "codex-plugin",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt,
    };

    const v2 = adaptAgentHarnessToV2(harness);
    const prepared = await v2.prepare(params);
    const session = await v2.start(prepared);

    expect(await v2.send(session)).toBe(result);
    expect(runAttempt).toHaveBeenCalledWith(params);
    expect(session).toMatchObject({
      harnessId: "codex",
      label: "Codex",
      pluginId: "codex-plugin",
      params,
    });
  });

  it("keeps result classification as an explicit outcome stage", async () => {
    const params = createAttemptParams();
    const result = createAttemptResult();
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(async () => result),
      classify: vi.fn(() => "empty"),
    };

    const v2 = adaptAgentHarnessToV2(harness);
    const session = await v2.start(await v2.prepare(params));

    expect(await v2.resolveOutcome(session, result)).toMatchObject({
      agentHarnessId: "codex",
      agentHarnessResultClassification: "empty",
    });
    expect(harness.classify).toHaveBeenCalledWith(result, params);
  });

  it("preserves existing compact/reset/dispose hooks as compatibility methods", async () => {
    const compact = vi.fn(async () => ({ ok: true, compacted: true, summary: "done" }) as const);
    const reset = vi.fn();
    const dispose = vi.fn();
    const harness: AgentHarness = {
      id: "custom",
      label: "Custom",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(async () => createAttemptResult()),
      compact,
      reset,
      dispose,
    };

    const v2 = adaptAgentHarnessToV2(harness);

    await expect(v2.compact?.({ sessionId: "session-1" } as never)).resolves.toMatchObject({
      compacted: true,
    });
    v2.reset?.({ reason: "reset" });
    await v2.dispose?.();

    expect(compact).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith({ reason: "reset" });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
