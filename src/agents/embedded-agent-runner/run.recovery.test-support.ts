import { vi } from "vitest";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { EmbeddedRunCompactionRecoveryInput } from "./run/compaction-runtime.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

export function createRecoveryOwner(
  input: EmbeddedRunCompactionRecoveryInput,
  assertRecoveryActive = () => input.assertRecoveryActive(),
) {
  const assertActive = composeSessionSourceAssertion([
    () => input.runParams.abortSignal?.throwIfAborted(),
    assertRecoveryActive,
  ]);
  assertActive();
  const session = input.getActiveSession();
  return {
    session: {
      ...session,
      target: {
        agentId: input.sessionAgentId,
        sessionId: session.id,
        sessionKey: input.resolvedSessionKey,
        storePath: "/tmp/workspace/openclaw-agent.sqlite",
      },
    },
    assertActive,
    withTranscriptWrites: async <T>(signal: AbortSignal | undefined, run: () => Promise<T>) => {
      signal?.throwIfAborted();
      assertActive();
      return await run();
    },
  };
}

export function createRecoveryDefaults(
  compact: ContextEngine["compact"],
  current: () => EmbeddedRunCompactionRecoveryInput,
) {
  return {
    runParams: {
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      config: {},
      workspaceDir: "/tmp/workspace",
      prompt: "continue",
      timeoutMs: 1_000,
      onAutoCompactionSucceeded: vi.fn(),
    },
    state: createEmbeddedRunContextRecoveryState(),
    assertRecoveryActive: vi.fn(),
    contextEngine: {
      info: { id: "legacy", name: "Legacy" },
      ingest: vi.fn(),
      assemble: vi.fn(),
      compact,
    },
    contextTokenBudget: 200_000,
    genericCompactionRecoveryAllowed: true,
    signalOwnedInterruption: false,
    runtimeAuthPlan: { providerForAuth: "openai", authProfileProviderForAuth: "openai" },
    resolvedSessionKey: "agent:main:session-1",
    sessionAgentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-luna",
      authProfileIdSource: "auto" as const,
    },
    thinkLevel: "off" as const,
    resolveContextEnginePluginId: () => undefined,
    buildRuntimeSettings: ({
      tokenBudget,
      degradedReason,
    }: Parameters<EmbeddedRunCompactionRecoveryInput["buildRuntimeSettings"]>[0]) => {
      const { provider, model } = current().modelSelection;
      return buildContextEngineRuntimeSettings({
        contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        provider,
        requestedModel: model,
        resolvedModel: model,
        promptTokenBudget: tokenBudget,
        degradedReason,
      });
    },
    onCompactionHookMessages: vi.fn(),
    runOwnsCompactionBeforeHook: vi.fn(async () => {}),
    runOwnsCompactionAfterHook: vi.fn(async () => {}),
    adoptCompactionTranscript: vi.fn(async () => undefined),
    getActiveSession: () => ({ id: "session-1", file: "/tmp/session-1.jsonl" }),
    prepareCompactedTranscriptRetry: vi.fn(async () => {}),
    armPostCompactionGuard: vi.fn(),
    usageAccumulator: createUsageAccumulator(),
  };
}
