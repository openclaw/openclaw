import { prependSystemPromptAdditionAfterCacheBoundary } from "@openclaw/ai/internal/shared";
import type { OpenClawConfig } from "../../config/config.js";
import { readActiveTranscriptEntryAnchorAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import { boundContextEngineAssembly } from "../../context-engine/bounded-context.js";
import {
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
  type ContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import { resolveContextEngineTranscriptByteLimit } from "../../context-engine/registry.js";
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
import {
  runWithPreparedRunSourceScope,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { runContextEngineMaintenance } from "../embedded-agent-runner/context-engine-maintenance.js";
import { estimateRenderedLlmBoundaryTokenPressure } from "../embedded-agent-runner/run/preemptive-compaction.js";
import { stripRuntimeContextCustomMessages } from "../internal-runtime-context.js";
import type { AgentMessage } from "../runtime/index.js";
import { sanitizeToolUseResultPairingForModel } from "../session-transcript-repair.js";
import {
  completedTurnMessageAnchor,
  type CompletedTurnMessageAnchor,
} from "../sessions/session-manager-message-anchor.js";
import {
  clearContextEngineAssemblySnapshot,
  readContextEngineAssemblyBudget,
  recordContextEngineAssemblySnapshot,
  type ContextEngineAssemblySnapshot,
} from "./context-engine-assembly-attempt.js";
import type { ContextEngineTurnAttemptFacts } from "./context-engine-turn-attempt.js";

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

type HarnessRuntimeSettingsParams = HarnessSourceScope & {
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

type HarnessSourceScope = {
  admittedRunContext?: AdmittedRunContext;
  preparedRunAdmission?: PreparedAgentRunAdmission;
};

function runWithHarnessSourceFence<T>(
  params: HarnessSourceScope & { transcriptReadFence?: UserTurnTranscriptAdmissionReceipt },
  run: () => Promise<T>,
): Promise<T> {
  return runWithSessionTranscriptReadFence(params.transcriptReadFence, () =>
    runWithPreparedRunSourceScope(params, run),
  );
}

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
  params: Omit<HarnessRuntimeSettingsParams, "modelFamily"> & {
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
  await runWithHarnessSourceFence(params, async () => {
    try {
      const runtimeSettings = buildHarnessContextEngineRuntimeSettings(params);
      const runtimeContext = preparePreTurnRuntimeContext(params.runtimeContext);
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
    } catch (bootstrapErr) {
      params.warn(`context engine bootstrap failed: ${String(bootstrapErr)}`);
    }
  });
}

type HarnessContextEngineAssemblyParams = Omit<
  HarnessRuntimeSettingsParams,
  "modelId" | "tokenBudget"
> & {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  appendOnlyRuntimeContext?: boolean;
  messages: AgentMessage[];
  tokenBudget?: number;
  availableTools?: Set<string>;
  citationsMode?: MemoryCitationsMode;
  sandboxed?: boolean;
  /** Current repository identity passed to memory prompt sections. */
  memoryProjectKey?: string;
  modelId: string;
  prompt?: string;
  runtimeContext?: ContextEngineRuntimeContext;
  transcriptReadFence?: UserTurnTranscriptAdmissionReceipt;
  promptBudget?: {
    contextTokens?: number;
    reserveTokens: number;
    inputTokens?: number;
    systemPrompt: string;
    prompt: string;
  };
};

export async function assembleHarnessContextEngine(params: HarnessContextEngineAssemblyParams) {
  clearContextEngineAssemblySnapshot();
  const contextEngine = params.contextEngine;
  if (!contextEngine) {
    return undefined;
  }
  const assembled = await runWithHarnessSourceFence(params, async () => {
    const assembly = await assembleHarnessContextEngineWithinSourceScope(params, contextEngine);
    const bounded = boundContextEngineAssembly(
      assembly.result,
      resolveContextEngineTranscriptByteLimit(contextEngine),
      resolveAssemblyHistoryTokenBudget(params),
    );
    return { result: bounded, snapshot: assembly.snapshot };
  });
  recordContextEngineAssemblySnapshot(assembled.snapshot);
  return assembled.result;
}

function resolveAssemblyHistoryTokenBudget(params: HarnessContextEngineAssemblyParams) {
  const explicitBudget = params.runtimeSettings?.limits.promptTokenBudget ?? params.tokenBudget;
  const tokenBudget =
    params.tokenBudget === undefined
      ? explicitBudget
      : explicitBudget === undefined
        ? params.tokenBudget
        : Math.min(params.tokenBudget, explicitBudget);
  if (!params.promptBudget) {
    return tokenBudget;
  }
  const {
    contextTokens,
    reserveTokens,
    inputTokens = 0,
    systemPrompt,
    prompt,
  } = params.promptBudget;
  const budget = Math.max(1, Math.floor(contextTokens ?? DEFAULT_CONTEXT_TOKENS));
  const historyBudget = Math.max(
    1,
    Math.max(1, budget - Math.max(0, Math.floor(reserveTokens))) -
      Math.max(0, Math.floor(inputTokens)) -
      estimateRenderedLlmBoundaryTokenPressure({ systemPrompt, prompt }),
  );
  return tokenBudget === undefined ? historyBudget : Math.min(tokenBudget, historyBudget);
}

async function assembleHarnessContextEngineWithinSourceScope(
  params: HarnessContextEngineAssemblyParams,
  contextEngine: ContextEngine,
) {
  const tokenBudget = resolveAssemblyHistoryTokenBudget(params);
  const maxOutputTokens = params.promptBudget
    ? Math.max(0, Math.floor(params.promptBudget.reserveTokens))
    : params.maxOutputTokens;
  // Append-only replay policies keep persisted carriers in the assembled window;
  // dropping one here would change the prefix bound to later thinking signatures.
  const messages = (
    params.appendOnlyRuntimeContext
      ? params.messages
      : stripRuntimeContextCustomMessages(params.messages)
  ).slice();
  const runtimeSettings = buildHarnessContextEngineRuntimeSettings({
    ...params,
    maxOutputTokens,
    tokenBudget,
  });
  const snapshot: ContextEngineAssemblySnapshot = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.providerId,
    modelId: params.modelId,
    tokenBudget,
  };
  const runtimeContext = preparePreTurnRuntimeContext(params.runtimeContext);
  const assemble = () =>
    contextEngine.assemble({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messages,
      tokenBudget,
      ...(params.availableTools ? { availableTools: params.availableTools } : {}),
      ...(params.citationsMode ? { citationsMode: params.citationsMode } : {}),
      model: params.modelId,
      runtimeSettings: {
        ...runtimeSettings,
        limits: { ...runtimeSettings.limits, promptTokenBudget: tokenBudget ?? null },
      },
      runtimeContext,
      ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
    });
  const result =
    contextEngine.info.id === "legacy"
      ? await assemble()
      : await runWithPreparedMemoryPromptSection(
          {
            availableTools: params.availableTools ?? new Set(),
            citationsMode: params.citationsMode,
            agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
            agentSessionKey: params.sessionKey,
            sandboxed: params.sandboxed,
            projectKey: params.memoryProjectKey,
          },
          assemble,
        );
  return { result: ensureAssembleResultShape(result, contextEngine.info.id), snapshot };
}

type PreparedHarnessContextEnginePrompt = {
  messages: AgentMessage[];
  systemPrompt: string;
  contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]>;
  unwindowedContextEngineMessagesForPrecheck?: AgentMessage[];
};

export async function prepareHarnessContextEnginePrompt(
  params: Parameters<typeof assembleHarnessContextEngine>[0] & {
    promptBudget: NonNullable<Parameters<typeof assembleHarnessContextEngine>[0]["promptBudget"]>;
    repairToolUseResultPairing: boolean;
    isOpenAIResponsesApi: boolean;
    warn: (message: string) => void;
  },
): Promise<PreparedHarnessContextEnginePrompt> {
  clearContextEngineAssemblySnapshot();
  const initial: PreparedHarnessContextEnginePrompt = {
    messages: params.messages,
    systemPrompt: params.promptBudget.systemPrompt,
    contextEnginePromptAuthority: "assembled",
  };
  const contextEngine = params.contextEngine;
  if (!contextEngine) {
    return {
      ...initial,
      messages: params.repairToolUseResultPairing
        ? sanitizeToolUseResultPairingForModel(initial.messages, params.isOpenAIResponsesApi)
        : initial.messages,
    };
  }
  let snapshot: ContextEngineAssemblySnapshot | undefined;
  const prepared = await runWithHarnessSourceFence(params, async () => {
    // Windowing and replay hooks can leave orphaned results before assembly.
    const pipelineMessages = params.repairToolUseResultPairing
      ? sanitizeToolUseResultPairingForModel(params.messages, params.isOpenAIResponsesApi)
      : params.messages;
    const preassemblyMessages = pipelineMessages.slice();
    // Repair before the final byte bound: synthetic results also consume budget.
    // Keep both operations inside the retained source-authority fence.
    const prepareAssembly = (assembled: AssembleResult) =>
      boundContextEngineAssembly(
        {
          ...assembled,
          messages: params.repairToolUseResultPairing
            ? sanitizeToolUseResultPairingForModel(assembled.messages, params.isOpenAIResponsesApi)
            : assembled.messages,
        },
        resolveContextEngineTranscriptByteLimit(contextEngine),
        resolveAssemblyHistoryTokenBudget(params),
      );
    let bounded: AssembleResult;
    try {
      const assembled = await assembleHarnessContextEngineWithinSourceScope(
        { ...params, messages: pipelineMessages },
        contextEngine,
      );
      bounded = prepareAssembly(assembled.result);
      snapshot = assembled.snapshot;
    } catch (error) {
      params.warn(`context engine assemble failed, using pipeline messages: ${String(error)}`);
      bounded = prepareAssembly({ messages: pipelineMessages, estimatedTokens: 0 });
    }
    const authority = bounded.promptAuthority ?? "assembled";
    return {
      messages: bounded.messages,
      systemPrompt: bounded.systemPromptAddition
        ? prependSystemPromptAdditionAfterCacheBoundary({
            systemPrompt: initial.systemPrompt,
            systemPromptAddition: bounded.systemPromptAddition,
          })
        : initial.systemPrompt,
      contextEnginePromptAuthority: authority,
      ...(authority === "preassembly_may_overflow"
        ? { unwindowedContextEngineMessagesForPrecheck: preassemblyMessages }
        : {}),
    };
  });
  if (snapshot) {
    recordContextEngineAssemblySnapshot(snapshot);
  }
  return prepared;
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
    modelContextWindow?: number;
    turnCandidate?: {
      admission?: UserTurnTranscriptAdmissionReceipt;
      terminalEntryId?: string | null;
      [completedTurnMessageAnchor]?: CompletedTurnMessageAnchor;
      record: (facts: ContextEngineTurnAttemptFacts) => void;
    };
  },
) {
  if (!params.contextEngine || params.promptError || params.aborted || params.yieldAborted) {
    return { postTurnFinalizationSucceeded: true };
  }
  if (params.turnCandidate) {
    const { admission, terminalEntryId, record } = params.turnCandidate;
    if (admission && terminalEntryId) {
      const committed = params.turnCandidate[completedTurnMessageAnchor];
      // Reconstructed managers need one anchor snapshot, not a version that a later append can stale.
      const terminal = committed
        ? committed.anchor
        : await readActiveTranscriptEntryAnchorAsync({ ...admission, entryId: terminalEntryId });
      committed?.assertCurrent();
      if (terminal) {
        record({
          boundary: { admission, terminal },
          sessionIdUsed: params.sessionIdUsed,
          sessionKey: params.sessionKey,
          sessionTarget: params.sessionTarget,
          promptError: params.promptError,
          aborted: params.aborted,
          yieldAborted: params.yieldAborted,
          isHeartbeat: params.isHeartbeat,
          runtimeContext: {
            provider: params.providerId ?? undefined,
            modelId: params.modelId ?? undefined,
            modelContextWindow: params.modelContextWindow,
            tokenBudget:
              readContextEngineAssemblyBudget({
                sessionId: params.sessionIdUsed,
                sessionKey: params.sessionKey,
                provider: params.providerId,
                modelId: params.modelId,
              }) ?? params.tokenBudget,
          },
        });
      }
    }
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

  if (postTurnFinalizationSucceeded) {
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
