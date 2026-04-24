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
      lifecycleState: "started",
    });
    expect(prepared.lifecycleState).toBe("prepared");
  });

  it("keeps result classification as an explicit outcome stage", async () => {
    const params = createAttemptParams();
    const result = createAttemptResult();
    const classify = vi.fn<NonNullable<AgentHarness["classify"]>>(() => "empty");
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(async () => result),
      classify,
    };

    const v2 = adaptAgentHarnessToV2(harness);
    const session = await v2.start(await v2.prepare(params));

    expect(await v2.resolveOutcome(session, result)).toMatchObject({
      agentHarnessId: "codex",
      agentHarnessResultClassification: "empty",
    });
    expect(harness.classify).toHaveBeenCalledWith(result, params);
  });

  it("clears stale non-ok classification when classification resolves to ok", async () => {
    const params = createAttemptParams();
    const result = {
      ...createAttemptResult(),
      agentHarnessResultClassification: "empty",
    } as EmbeddedRunAttemptResult;
    const classify = vi.fn<NonNullable<AgentHarness["classify"]>>(() => "ok");
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(async () => result),
      classify,
    };

    const v2 = adaptAgentHarnessToV2(harness);
    const session = await v2.start(await v2.prepare(params));

    const classified = await v2.resolveOutcome(session, result);
    expect(classified).toMatchObject({ agentHarnessId: "codex" });
    expect(classified).not.toHaveProperty("agentHarnessResultClassification");
  });

  it("preserves existing compact/reset/dispose hook this binding as compatibility methods", async () => {
    const harness: AgentHarness & {
      compactCalls: number;
      resetCalls: number;
      disposeCalls: number;
    } = {
      id: "custom",
      label: "Custom",
      compactCalls: 0,
      resetCalls: 0,
      disposeCalls: 0,
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(async () => createAttemptResult()),
      async compact() {
        this.compactCalls += 1;
        return {
          ok: true,
          compacted: true,
          result: {
            summary: "done",
            firstKeptEntryId: "entry-1",
            tokensBefore: 100,
          },
        };
      },
      reset(params) {
        expect(params).toEqual({ reason: "reset" });
        this.resetCalls += 1;
      },
      dispose() {
        this.disposeCalls += 1;
      },
    };

    const v2 = adaptAgentHarnessToV2(harness);

    await expect(
      v2.compact?.({
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
      }),
    ).resolves.toMatchObject({
      compacted: true,
    });
    await v2.reset?.({ reason: "reset" });
    await v2.dispose?.();

    expect(harness.compactCalls).toBe(1);
    expect(harness.resetCalls).toBe(1);
    expect(harness.disposeCalls).toBe(1);
  });

  it("does not dispose V1 harnesses during per-attempt cleanup", async () => {
    const dispose = vi.fn();
    const harness: AgentHarness = {
      id: "custom",
      label: "Custom",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(async () => createAttemptResult()),
      dispose,
    };
    const v2 = adaptAgentHarnessToV2(harness);
    const session = await v2.start(await v2.prepare(createAttemptParams()));

    await v2.cleanup({ session, result: createAttemptResult() });

    expect(dispose).not.toHaveBeenCalled();
  });
});
