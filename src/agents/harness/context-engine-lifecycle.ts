import type { OpenClawConfig } from "../../config/config.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import {
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
  type ContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type {
  AssembleResult,
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
  ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import { runWithPreparedMemoryPromptSection } from "../../plugins/memory-state.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { runContextEngineMaintenance } from "../embedded-agent-runner/context-engine-maintenance.js";
import { stripRuntimeContextCustomMessages } from "../internal-runtime-context.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SemanticTurnContextOptions } from "./semantic-turn-context.js";

export {
  buildAfterTurnRuntimeContext as buildHarnessContextEngineRuntimeContext,
  buildAfterTurnRuntimeContextFromUsage as buildHarnessContextEngineRuntimeContextFromUsage,
} from "../embedded-agent-runner/run/attempt-prompt-helpers.js";

function preparePreTurnRuntimeContext(
  runtimeContext: ContextEngineRuntimeContext | undefined,
): ContextEngineRuntimeContext | undefined {
  if (!runtimeContext?.rewriteTranscriptEntries) {
    return runtimeContext;
  }
  const { rewriteTranscriptEntries: _rewriteTranscriptEntries, ...fenced } = runtimeContext;
  return fenced;
}

type HarnessRuntimeSettingsParams = {
  runtimeSettings?: ContextEngineRuntimeSettings;
  contextEngineHostSupport?: ContextEngineHostSupport;
  harnessId?: string | null;
  runtimeId?: string | null;
  providerId?: string | null;
  requestedModelId?: string | null;
  modelId?: string | null;
  modelFamily?: string | null;
  tokenBudget?: number | null;
  maxOutputTokens?: number | null;
  fallbackReason?: string | null;
  degradedReason?: string | null;
  contextEngine?: ContextEngine;
};

function buildHarnessContextEngineRuntimeSettings(
  params: HarnessRuntimeSettingsParams,
): ContextEngineRuntimeSettings {
  if (params.runtimeSettings !== undefined && params.runtimeSettings !== null) {
    return params.runtimeSettings;
  }
  const selectedId = params.contextEngine?.info.id;
  return buildContextEngineRuntimeSettings({
    contextEngineHost: params.contextEngineHostSupport ?? OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
    harnessId: params.harnessId,
    runtimeId: params.runtimeId,
    provider: params.providerId,
    requestedModel: params.requestedModelId,
    resolvedModel: params.modelId ?? params.requestedModelId,
    // Model ids do not attest a model family.
    modelFamily: params.modelFamily ?? null,
    selectedContextEngineId: selectedId,
    contextEngineSelectionSource:
      selectedId === "legacy" ? "default" : selectedId ? "configured" : "unknown",
    promptTokenBudget: params.tokenBudget,
    maxOutputTokens: params.maxOutputTokens,
    fallbackReason: params.fallbackReason,
    degradedReason: params.degradedReason,
  });
}

export async function bootstrapHarnessContextEngine(
  params: Omit<HarnessRuntimeSettingsParams, "modelFamily" | "tokenBudget"> & {
    hadSessionFile: boolean;
    sessionId: string;
    sessionKey?: string;
    sessionTarget?: ContextEngineSessionTarget;
    sessionFile: string;
    sessionManager?: unknown;
    runtimeContext?: ContextEngineRuntimeContext;
    transcriptReadFence?: UserTurnTranscriptAdmissionReceipt;
    runMaintenance?: typeof runHarnessContextEngineMaintenance;
    config?: OpenClawConfig;
    warn: (message: string) => void;
  },
): Promise<void> {
  if (
    !params.hadSessionFile ||
    !(params.contextEngine?.bootstrap || params.contextEngine?.maintain)
  ) {
    return;
  }
  try {
    const runtimeSettings = buildHarnessContextEngineRuntimeSettings(params);
    const runtimeContext = preparePreTurnRuntimeContext(params.runtimeContext);
    await runWithSessionTranscriptReadFence(params.transcriptReadFence, async () => {
      if (typeof params.contextEngine?.bootstrap === "function") {
        await params.contextEngine.bootstrap({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionTarget: params.sessionTarget,
          sessionFile: params.sessionFile,
          runtimeSettings,
          runtimeContext,
        });
      }
      await (params.runMaintenance ?? runHarnessContextEngineMaintenance)({
        contextEngine: params.contextEngine,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionTarget: params.sessionTarget,
        sessionFile: params.sessionFile,
        reason: "bootstrap",
        sessionManager: params.sessionManager,
        runtimeContext,
        runtimeSettings,
        config: params.config,
      });
    });
  } catch (bootstrapErr) {
    params.warn(`context engine bootstrap failed: ${String(bootstrapErr)}`);
  }
}

export async function assembleHarnessContextEngine(
  params: Omit<HarnessRuntimeSettingsParams, "modelId" | "tokenBudget"> & {
    sessionId: string;
    sessionKey?: string;
    agentId?: string;
    appendOnlyRuntimeContext?: boolean;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    citationsMode?: MemoryCitationsMode;
    sandboxed?: boolean;
    modelId: string;
    prompt?: string;
    runtimeContext?: ContextEngineRuntimeContext;
    transcriptReadFence?: UserTurnTranscriptAdmissionReceipt;
    /** Captured run authority; optional for hosts that have not adopted semantic observation. */
    semanticCuration?: SemanticTurnContextOptions;
  },
) {
  if (!params.contextEngine) {
    return undefined;
  }
  const contextEngine = params.contextEngine;
  // Append-only replay policies keep persisted carriers in the assembled window;
  // dropping one here would change the prefix bound to later thinking signatures.
  const messages = (
    params.appendOnlyRuntimeContext
      ? params.messages
      : stripRuntimeContextCustomMessages(params.messages)
  ).slice();
  const runtimeSettings = buildHarnessContextEngineRuntimeSettings(params);
  const runtimeContext = preparePreTurnRuntimeContext(params.runtimeContext);
  const assemble = () =>
    contextEngine.assemble({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messages,
      tokenBudget: params.tokenBudget,
      ...(params.availableTools ? { availableTools: params.availableTools } : {}),
      ...(params.citationsMode ? { citationsMode: params.citationsMode } : {}),
      model: params.modelId,
      runtimeSettings,
      runtimeContext,
      ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
    });
  const result = await runWithSessionTranscriptReadFence(params.transcriptReadFence, async () =>
    contextEngine.info.id === "legacy"
      ? await assemble()
      : await runWithPreparedMemoryPromptSection(
          {
            availableTools: params.availableTools ?? new Set(),
            citationsMode: params.citationsMode,
            agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
            agentSessionKey: params.sessionKey,
            sandboxed: params.sandboxed,
          },
          assemble,
        ),
  );
  const assembled = ensureAssembleResultShape(result, contextEngine.info.id);
  if (
    !params.semanticCuration ||
    params.semanticCuration.config?.mode !== "shadow" ||
    !params.semanticCuration.isEligible()
  ) {
    return assembled;
  }
  const { observeSemanticTurnContext } = await import("./semantic-turn-context.js");
  return observeSemanticTurnContext(assembled, {
    ...params.semanticCuration,
    prompt: params.prompt,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
    appendOnly:
      params.appendOnlyRuntimeContext || params.contextEngineHostSupport?.id === "codex-app-server",
  });
}

/** Invalid plugin results must fail here so the runner can fall back without poisoning state. */
function ensureAssembleResultShape(result: unknown, engineId: string): AssembleResult {
  if (!result || typeof result !== "object") {
    throw new Error(
      `context engine "${engineId}" assemble() returned an invalid result: expected an object with a "messages" array (got ${describeAssembleResultType(result)})`,
    );
  }
  const candidate = result as { messages?: unknown };
  if (!Array.isArray(candidate.messages)) {
    throw new Error(
      `context engine "${engineId}" assemble() returned an invalid result: expected an object with a "messages" array (got messages of type ${describeAssembleResultType(candidate.messages)})`,
    );
  }
  return result as AssembleResult;
}

function describeAssembleResultType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

export async function finalizeHarnessContextEngineTurn(
  params: Omit<HarnessRuntimeSettingsParams, "modelFamily" | "tokenBudget"> & {
    promptError: boolean;
    aborted: boolean;
    yieldAborted: boolean;
    sessionIdUsed: string;
    sessionKey?: string;
    sessionTarget?: ContextEngineSessionTarget;
    sessionFile: string;
    messagesSnapshot: AgentMessage[];
    prePromptMessageCount: number;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
    runMaintenance?: typeof runHarnessContextEngineMaintenance;
    sessionManager?: unknown;
    config?: OpenClawConfig;
    warn: (message: string) => void;
    /** True when this turn belongs to a heartbeat run. */
    isHeartbeat?: boolean;
  },
) {
  if (!params.contextEngine) {
    return { postTurnFinalizationSucceeded: true };
  }
  if (params.promptError || params.aborted || params.yieldAborted) {
    return { postTurnFinalizationSucceeded: true };
  }

  const conversationSnapshot = buildContextEngineConversationSnapshot({
    messagesSnapshot: params.messagesSnapshot,
    prePromptMessageCount: params.prePromptMessageCount,
  });
  const runtimeSettings = buildHarnessContextEngineRuntimeSettings(params);
  const runtimeContext = params.runtimeContext;
  let postTurnFinalizationSucceeded = true;

  if (typeof params.contextEngine.afterTurn === "function") {
    try {
      await params.contextEngine.afterTurn({
        sessionId: params.sessionIdUsed,
        sessionKey: params.sessionKey,
        sessionTarget: params.sessionTarget,
        sessionFile: params.sessionFile,
        messages: conversationSnapshot.messages,
        prePromptMessageCount: conversationSnapshot.prePromptMessageCount,
        tokenBudget: params.tokenBudget,
        runtimeSettings,
        runtimeContext,
        isHeartbeat: params.isHeartbeat,
      });
    } catch (afterTurnErr) {
      postTurnFinalizationSucceeded = false;
      params.warn(`context engine afterTurn failed: ${String(afterTurnErr)}`);
    }
  } else {
    const newMessages = conversationSnapshot.messages.slice(
      conversationSnapshot.prePromptMessageCount,
    );
    if (newMessages.length > 0) {
      if (typeof params.contextEngine.ingestBatch === "function") {
        try {
          await params.contextEngine.ingestBatch({
            sessionId: params.sessionIdUsed,
            sessionKey: params.sessionKey,
            messages: newMessages,
            isHeartbeat: params.isHeartbeat,
          });
        } catch (ingestErr) {
          postTurnFinalizationSucceeded = false;
          params.warn(`context engine ingest failed: ${String(ingestErr)}`);
        }
      } else {
        for (const msg of newMessages) {
          try {
            await params.contextEngine.ingest?.({
              sessionId: params.sessionIdUsed,
              sessionKey: params.sessionKey,
              message: msg,
              isHeartbeat: params.isHeartbeat,
            });
          } catch (ingestErr) {
            postTurnFinalizationSucceeded = false;
            params.warn(`context engine ingest failed: ${String(ingestErr)}`);
          }
        }
      }
    }
  }

  if (
    !params.promptError &&
    !params.aborted &&
    !params.yieldAborted &&
    postTurnFinalizationSucceeded
  ) {
    await (params.runMaintenance ?? runHarnessContextEngineMaintenance)({
      contextEngine: params.contextEngine,
      sessionId: params.sessionIdUsed,
      sessionKey: params.sessionKey,
      sessionTarget: params.sessionTarget,
      sessionFile: params.sessionFile,
      reason: "turn",
      sessionManager: params.sessionManager,
      runtimeContext,
      runtimeSettings,
      config: params.config,
    });
  }

  return { postTurnFinalizationSucceeded };
}

function buildContextEngineConversationSnapshot(params: {
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
}): { messages: AgentMessage[]; prePromptMessageCount: number } {
  const prePromptMessages = stripRuntimeContextCustomMessages(
    params.messagesSnapshot.slice(0, params.prePromptMessageCount),
  );
  const turnMessages = stripRuntimeContextCustomMessages(
    params.messagesSnapshot.slice(params.prePromptMessageCount),
  );
  return {
    messages: [...prePromptMessages, ...turnMessages],
    prePromptMessageCount: prePromptMessages.length,
  };
}

export async function runHarnessContextEngineMaintenance(
  params: Omit<HarnessRuntimeSettingsParams, "modelFamily"> & {
    sessionId: string;
    sessionKey?: string;
    sessionTarget?: ContextEngineSessionTarget;
    sessionFile: string;
    reason: "bootstrap" | "compaction" | "turn";
    sessionManager?: unknown;
    runtimeContext?: ContextEngineRuntimeContext;
    executionMode?: "foreground" | "background";
    onDeferredMaintenance?: (promise: Promise<void>) => void;
    withSessionManagerRewriteLock?: <T>(operation: () => Promise<T> | T) => Promise<T>;
    config?: OpenClawConfig;
  },
) {
  const runtimeSettings = buildHarnessContextEngineRuntimeSettings(params);
  return await runContextEngineMaintenance({
    contextEngine: params.contextEngine,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
    sessionFile: params.sessionFile,
    reason: params.reason,
    sessionManager: params.sessionManager as Parameters<
      typeof runContextEngineMaintenance
    >[0]["sessionManager"],
    withSessionManagerRewriteLock: params.withSessionManagerRewriteLock,
    runtimeContext: params.runtimeContext,
    runtimeSettings,
    executionMode: params.executionMode,
    onDeferredMaintenance: params.onDeferredMaintenance,
    config: params.config,
  });
}

export function isActiveHarnessContextEngine(
  contextEngine: ContextEngine | undefined,
): contextEngine is ContextEngine {
  return Boolean(contextEngine && contextEngine.info.id !== "legacy");
}
