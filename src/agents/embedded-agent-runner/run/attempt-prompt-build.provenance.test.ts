// #143821: prompt-build hook context must carry the turn's typed input provenance so
// plugins can distinguish inter-session deliveries from human messages.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { PluginHookAgentContext } from "../../../plugins/hook-types.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-build.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

vi.mock("../../../plugins/host-hook-state.js", () => ({
  drainPluginNextTurnInjectionContext: vi.fn(async () => ({ queuedInjections: [] })),
}));

registerAgentSessionLoopTestLifecycle();

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function assembleWithCapturedHookCtx(
  runId: string,
  attemptOverrides?: Partial<EmbeddedRunAttemptParams>,
) {
  const { session, sessionManager, modelRegistry } = await createTestSession();
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "provenance-hook-test");
  onTestFinished(() => {
    admission.close();
    forgetPromptBuildDrainCacheForRun(runId);
  });
  const attempt: EmbeddedRunAttemptParams = {
    admittedRunContext: await admission.admit("embedded"),
    authStorage: modelRegistry.authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry,
    config: {},
    model: testModel,
    modelId: testModel.id,
    provider: testModel.provider,
    thinkLevel: "off",
    prompt: "Handoff payload",
    transcriptPrompt: "Handoff payload",
    runId,
    sessionId: runId,
    sessionKey: `agent:main:${runId}`,
    sessionFile: "",
    sessionPersistence: "detached",
    trigger: "user",
    timeoutMs: 10_000,
    workspaceDir: "/tmp/provenance-hook-test",
    ...attemptOverrides,
  };
  const captured: PluginHookAgentContext[] = [];
  const hookRunner = createHookRunner({
    hooks: [],
    plugins: [],
    typedHooks: [
      {
        pluginId: "provenance-hook-test",
        hookName: "before_prompt_build",
        source: "test",
        handler: async (_event: unknown, ctx: PluginHookAgentContext) => {
          captured.push(ctx);
        },
      },
    ],
  });
  await prepareEmbeddedAttemptPromptAssembly({
    attempt,
    activeSession: session,
    sessionManager,
    hookRunner,
    hookAgentId: "main",
    diagnosticTrace: { traceId: "11111111111111111111111111111111" },
    isRawModelRun: false,
    sessionAgentId: "main",
    runtimeModel: testModel.id,
    systemPromptText: "Base system prompt",
    applyPromptBuildToolsAllow: () => [],
    setActiveSessionSystemPrompt: vi.fn(),
    setLeasedSteering: vi.fn(),
  });
  return captured;
}

describe("prompt-build hook context input provenance", () => {
  it("exposes inter-session provenance on the before_prompt_build context", async () => {
    const captured = await assembleWithCapturedHookCtx("provenance-hook-inter-session", {
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:session-a",
        sourceTool: "sessions_send",
      },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      trigger: "user",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:session-a",
        sourceTool: "sessions_send",
      },
    });
  });

  it("leaves provenance undefined for ordinary human turns", async () => {
    const captured = await assembleWithCapturedHookCtx("provenance-hook-human-turn");

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ trigger: "user" });
    expect(captured[0]?.inputProvenance).toBeUndefined();
  });
});
