import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { getPluginRegistryForContext, requireActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import { createModelGenerationFixture } from "../embedded-agent-runner/model.generation-scope.test-support.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../embedded-agent-runner/run/types.js";
import { retainPreparedPluginRegistry } from "../prepared-model-runtime.plugin-lifetime.js";
import { maybeCompactAgentHarnessSession as maybeCompactAgentHarnessSessionImpl } from "./compaction.js";

export function createHarnessAttemptParams(
  admittedRunContext: AdmittedRunContext,
  config?: OpenClawConfig,
): EmbeddedRunAttemptParams {
  return {
    admittedRunContext,
    prompt: "hello",
    sessionId: "session-1",
    runId: admittedRunContext.operationalRunInstance.runId,
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: { id: "gpt-5.4", provider: "codex" } as Model,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    thinkLevel: "low",
    config,
  } as EmbeddedRunAttemptParams;
}

export function createHarnessCompactionFixture(
  readFixture: () => { state: OpenClawTestState; admittedRunContext: AdmittedRunContext },
) {
  return function maybeCompactAgentHarnessSession(
    params: Parameters<typeof maybeCompactAgentHarnessSessionImpl>[0],
    options: Partial<Parameters<typeof maybeCompactAgentHarnessSessionImpl>[1]> = {},
  ) {
    const fixture = readFixture();
    const preparedModelRuntime = options.preparedModelRuntime ?? {
      ...createModelGenerationFixture({
        agentDir: fixture.state.agentDir(),
        workspaceDir: fixture.state.workspaceDir,
        config: params.config ?? {},
        createStores: () => ({ authStorage: {} as never, modelRegistry: {} as never }),
        label: "harness-test",
      }).preparedModelRuntime,
      pluginRegistry: getPluginRegistryForContext() ?? undefined,
    };
    const sourceAdmission = fixture.admittedRunContext;
    return maybeCompactAgentHarnessSessionImpl(params, {
      ...options,
      preparedModelRuntime,
      sourceAuthority: options.sourceAuthority ?? {
        operatorAuthority: undefined,
        assertActive: () => {
          if (!getAdmittedRunDelegatedAuthority(sourceAdmission)) {
            throw new Error("Harness selection fixture admission is closed");
          }
        },
      },
    });
  };
}

export async function withOwnedHarnessGeneration<Registered, Result>(
  generation: ReturnType<typeof createModelGenerationFixture>,
  register: () => Registered,
  run: (registered: Registered) => Promise<Result>,
): Promise<Result> {
  requireActivePluginRegistry();
  const release = retainPreparedPluginRegistry(generation.pluginRegistry);
  if (!release) {
    throw new Error("Harness generation fixture must own its prepared registry");
  }
  try {
    const registered = withPluginRuntimeGenerationScope(generation.preparedModelRuntime, register);
    // The caller stays outside registration scope to exercise production generation binding.
    return await run(registered);
  } finally {
    await release();
  }
}

export function createTranscriptRecorder(
  admission: ReturnType<typeof createTranscriptAnchor> & {
    logicalTurnId: string;
    role: "user";
  },
): UserTurnTranscriptRecorder {
  const message = { role: "user" as const, content: "hello", timestamp: 1 };
  return {
    message,
    resolveMessage: async () => message,
    getAdmissionReceipt: () => admission,
    markRuntimePersistencePending: () => {},
    markRuntimePersisted: () => {},
    markBlocked: () => {},
    hasPersisted: () => true,
    isBlocked: () => false,
    hasRuntimePersistencePending: () => false,
    waitForRuntimePersistence: async () => {},
    persistApproved: async () => undefined,
    persistBlocked: async () => undefined,
    persistFallback: async () => undefined,
  };
}

export function createAttemptResult(sessionIdUsed: string): EmbeddedRunAttemptResult {
  return {
    terminal: { kind: "ok" },
    sessionIdUsed,
    messagesSnapshot: [],
    assistantTexts: [`${sessionIdUsed} ok`],
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

export function createTranscriptAnchor(
  entryId: string,
  rawSeq: number,
  activeMessagePosition: number,
): TranscriptEntryAnchor {
  return {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    storePath: "/tmp/openclaw-agent.sqlite",
    generation: "generation-1",
    entryId,
    effectiveParentId: rawSeq === 1 ? null : "user-1",
    rawSeq,
    activeMessagePosition,
  };
}

export function providerRuntimeConfig(provider: string, runtime: string): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://api.openai.com/v1",
          agentRuntime: { id: runtime },
          models: [],
        },
      },
    },
  } as OpenClawConfig;
}
