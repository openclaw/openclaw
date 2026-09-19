import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { getCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadExactSessionEntryCandidates,
  patchSessionEntryCore,
  resolveSessionEntrySelection,
  resolveSessionTranscriptDatabasePath,
} from "../../config/sessions/session-accessor.js";
import type {
  SessionEntryReadSource,
  SessionTranscriptReadScope,
  SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.types.js";
import { resolvePersistedSessionStoreOwnerForTarget } from "../../config/sessions/session-store-owner.js";
import {
  captureOwnedTranscriptWriteAssertion,
  SessionTranscriptWriterClaimReboundError,
  getOwnedSessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import { appendExactAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { buildGenericCliContextEngineHostSupport } from "../../context-engine/host-compat.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { StopReason } from "../../llm/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseWrite } from "../../state/openclaw-agent-db-write.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { isHeartbeatLifecycleRunKind } from "../bootstrap-mode.js";
import type { CliOutput } from "../cli-output-contracts.js";
import {
  awaitAgentEndSideEffects,
  runAgentEndSideEffects,
} from "../harness/agent-end-side-effects.js";
import {
  finalizeHarnessContextEngineTurn,
  runHarnessContextEngineMaintenance,
} from "../harness/context-engine-lifecycle.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../harness/transcript-visibility.js";
import type { AgentMessage } from "../runtime/index.js";
import { withSessionManagerWrite } from "../sessions/session-manager-write-admission.js";
import { SessionManager } from "../sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../stream-message-shared.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const log = createSubsystemLogger("agents/cli-runner");

export function buildCliHookUserMessage(prompt: string): unknown {
  return {
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  };
}

/** Interrupted turns persist as aborted so replayed history never treats partial text as complete. */
export function resolveCliAssistantStopReason(output: CliOutput): StopReason {
  return output.terminalInterruption ? "aborted" : "stop";
}

export function buildCliHookAssistantMessage(params: {
  text: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  stopReason: StopReason;
}): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: "responses",
    provider: params.provider,
    model: params.model,
    ...(params.usage ? { usage: params.usage } : {}),
    stopReason: params.stopReason,
    timestamp: Date.now(),
  };
}

function isAgentMessage(value: unknown): value is AgentMessage {
  return Boolean(value && typeof value === "object" && "role" in value);
}

function buildCliContextEngineUserMessage(prompt: string): AgentMessage {
  return {
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  } as AgentMessage;
}

type CliAgentEndHookParams = Parameters<typeof runAgentEndSideEffects>[0];

function shouldAwaitCliAgentEndHook(params: RunCliAgentParams): boolean {
  return !params.messageChannel && !params.messageProvider;
}

export async function runCliAgentEndHook(
  params: RunCliAgentParams,
  hookParams: CliAgentEndHookParams,
): Promise<void> {
  if (shouldAwaitCliAgentEndHook(params)) {
    await awaitAgentEndSideEffects(hookParams);
    return;
  }
  runAgentEndSideEffects(hookParams);
}

export async function persistApprovedCliUserTurnTranscript(
  params: RunCliAgentParams,
): Promise<boolean> {
  const recorder = params.userTurnTranscriptRecorder;
  const reusingPersistedTurn = params.suppressNextUserMessagePersistence === true;
  if (!recorder || (reusingPersistedTurn && !recorder.hasPersisted())) {
    return recorder?.isBlocked() === true;
  }

  const persisted = await recorder.persistApproved({
    cwd: params.cwd ?? params.workspaceDir,
  });
  if (!persisted && !recorder.hasPersisted() && (await recorder.resolveMessage())) {
    // A prepared user row can be rejected by before_message_write. Preserve
    // that terminal decision so outer transcript mirrors do not retry it.
    recorder.markBlocked();
  }
  if (persisted && !reusingPersistedTurn) {
    try {
      const notification = params.onUserMessagePersisted?.(persisted.message);
      if (notification) {
        void Promise.resolve(notification).catch((error: unknown) => {
          log.warn(`CLI user turn persistence notification failed: ${formatErrorMessage(error)}`);
        });
      }
    } catch (error) {
      log.warn(`CLI user turn persistence notification failed: ${formatErrorMessage(error)}`);
    }
  }
  return persisted !== undefined || recorder.hasPersisted() || recorder.isBlocked();
}

/**
 * Persists the reply a before_agent_reply claim owns as this turn's transcript answer.
 * The synthetic turn never reaches the CLI attempt that normally records the answer, so
 * without this the reply stays visible in chat but absent from the session transcript
 * (#149985). Silent claims carry no reply text and record nothing.
 */
export async function persistClaimedCliAssistantReply(params: {
  runParams: RunCliAgentParams;
  text: string | undefined;
}): Promise<{ owned: boolean; idempotencyKey?: string } | undefined> {
  const text = params.text?.trim();
  if (!text) {
    return undefined;
  }
  return await persistCliAssistantTranscript({
    runParams: params.runParams,
    text,
    modelId: params.runParams.model ?? "",
    stopReason: "stop",
  });
}

export async function persistCliAssistantTranscript(params: {
  runParams: RunCliAgentParams;
  text: string;
  modelId: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  stopReason: StopReason;
  yielded?: true;
}): Promise<{
  owned: boolean;
  idempotencyKey?: string;
  terminalAnchor?: import("../../config/sessions/session-accessor.js").TranscriptEntryAnchor;
}> {
  const { runParams } = params;
  if (runParams.currentInboundEventKind === "room_event") {
    const admission = runParams.userTurnTranscriptRecorder?.getAdmissionReceipt();
    return {
      owned: true,
      ...(admission ? { terminalAnchor: admission } : {}),
    };
  }
  if (!params.text) {
    const admission = runParams.userTurnTranscriptRecorder?.getAdmissionReceipt();
    return {
      owned: false,
      ...(admission ? { terminalAnchor: admission } : {}),
    };
  }
  if (!runParams.persistAssistantTranscript || !runParams.sessionKey) {
    return { owned: false };
  }
  try {
    const idempotencyKey = `cli-assistant:${runParams.runId}`;
    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey: runParams.sessionKey,
      agentId: runParams.agentId,
      expectedSessionId: runParams.sessionId,
      ...(runParams.expectedLifecycleRevision !== undefined
        ? { expectedLifecycleRevision: runParams.expectedLifecycleRevision }
        : {}),
      ...(runParams.expectedWriterRunId !== undefined
        ? { expectedWriterRunId: runParams.expectedWriterRunId }
        : {}),
      storePath: runParams.storePath,
      idempotencyKey,
      config: runParams.config,
      beforeMessageWrite: (write) => {
        const message = runAgentHarnessBeforeMessageWriteHook({
          ...write,
          message: projectAgentHarnessTranscriptMessageForDisplay({
            hidden: false,
            inputProvenance: runParams.inputProvenance,
            message: write.message,
          }),
          prepareAssistantTranscriptMessage: runParams.prepareAssistantTranscriptMessage,
        });
        return message
          ? projectAgentHarnessTranscriptMessageForDisplay({
              hidden: false,
              inputProvenance: runParams.inputProvenance,
              message,
            })
          : null;
      },
      message: {
        ...buildAssistantMessage({
          model: {
            api: "cli",
            provider: runParams.provider,
            id: params.modelId,
          },
          content: [{ type: "text", text: params.text }],
          stopReason: params.stopReason,
          usage: buildUsageWithNoCost({
            input: params.usage?.input,
            output: params.usage?.output,
            cacheRead: params.usage?.cacheRead,
            cacheWrite: params.usage?.cacheWrite,
            totalTokens: params.usage?.total,
          }),
        }),
        // A paused turn owns visible progress, not a final answer. Keep the
        // existing keyed-segment contract without hiding narration or media.
        ...(params.yielded && params.stopReason === "stop"
          ? {
              openclawStreamFallback: {
                replacementText: params.text,
                source: "segment",
                itemId: runParams.runId,
              },
            }
          : {}),
      },
    });
    if (!result.ok) {
      log.warn(`CLI assistant transcript persistence skipped: ${result.reason}`);
      return { owned: result.code === "blocked" || result.code === "session-rebound" };
    }
    return {
      owned: true,
      idempotencyKey,
      ...(result.anchor ? { terminalAnchor: result.anchor } : {}),
    };
  } catch (error) {
    log.warn(`CLI assistant transcript persistence failed: ${formatErrorMessage(error)}`);
    return { owned: false };
  }
}

async function notifyCliUserMessagePersisted(
  params: RunCliAgentParams,
  message: Extract<AgentMessage, { role: "user" }>,
  context: string,
): Promise<void> {
  try {
    await Promise.resolve(params.onUserMessagePersisted?.(message));
  } catch (err) {
    log.warn(`${context} notification failed: ${formatErrorMessage(err)}`);
  }
}

function captureCliBlockFallbackWrite(
  target: SessionTranscriptRuntimeTarget,
  expectedEntry: InternalSessionEntry,
) {
  const identity = { ...target };
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const readScope = { ...identity, env } satisfies SessionTranscriptReadScope;
  const assertOwnedWrite = captureOwnedTranscriptWriteAssertion(identity);
  const fence = getOwnedSessionTranscriptWriterFence({
    sessionKey: identity.sessionKey,
    sessionTarget: identity,
  });
  const { normalizedKey } = resolveSessionEntrySelection(readScope, { readOnly: true });
  let source: SessionEntryReadSource | undefined;
  const captured = loadExactSessionEntryCandidates({
    ...readScope,
    sessionKeys: [normalizedKey],
    readOnly: true,
    onReadSource: (readSource) => {
      source = readSource;
    },
  })[0]?.entry;
  if (!source || !captured || captured.sessionId !== identity.sessionId) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const readSource = source;
  const { lifecycleRevision, activeWriterRunId } = expectedEntry;
  const cliWriter = getCliHistoryWriter({ ...identity, storePath: readSource.path });
  const assertCurrent = () => {
    assertOwnedWrite();
    cliWriter?.assertCurrent();
    const current = loadExactSessionEntryCandidates({
      ...readScope,
      sessionKeys: [normalizedKey],
      readOnly: true,
      onReadSource: (currentSource) => {
        if (
          currentSource.agentId !== readSource.agentId ||
          currentSource.path !== readSource.path
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
      },
    })[0]?.entry;
    if (
      !current ||
      current.sessionId !== identity.sessionId ||
      current.lifecycleRevision !== lifecycleRevision ||
      current.activeWriterRunId !== activeWriterRunId ||
      (fence?.expectedLifecycleRevision !== undefined &&
        current.lifecycleRevision !== fence.expectedLifecycleRevision) ||
      (fence?.expectedWriterRunId !== undefined &&
        current.activeWriterRunId !== fence.expectedWriterRunId)
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  };
  return { databaseOptions: { ...readSource, env }, readScope, assertCurrent };
}

export async function persistCliRunBlock(
  params: RunCliAgentParams,
  block: { message: string; pluginId: string },
): Promise<void> {
  const nowMs = Date.now();
  const redactedUserMessage = {
    role: "user" as const,
    content: [{ type: "text" as const, text: block.message }],
    timestamp: nowMs,
    idempotencyKey: `hook-block:before_agent_run:user:${params.runId}`,
    __openclaw: {
      beforeAgentRunBlocked: {
        blockedBy: block.pluginId,
        blockedAt: nowMs,
      },
    },
  };
  try {
    const persisted = await params.userTurnTranscriptRecorder?.persistBlocked(redactedUserMessage);
    if (persisted) {
      await notifyCliUserMessagePersisted(
        params,
        persisted.message,
        "before_agent_run block user-turn persistence",
      );
      return;
    }
  } catch (err) {
    log.warn(
      `before_agent_run block: failed to persist canonical CLI user message: ${formatErrorMessage(
        err,
      )}`,
    );
  }

  try {
    const sessionManager = params.sessionManager;
    if (!sessionManager) {
      const sessionKey = params.sessionKey?.trim() || params.sessionId;
      const targetAgentId = params.sessionTarget?.agentId;
      const targetStorePath = params.sessionTarget?.storePath;
      const targetStoreOwner = resolvePersistedSessionStoreOwnerForTarget({
        config: params.config ?? {},
        sessionKey,
        storePath: targetStorePath,
      });
      const explicitAlternateStoreAgentId =
        targetAgentId &&
        targetStorePath &&
        !parseAgentSessionKey(sessionKey)?.agentId &&
        targetStoreOwner.kind === "none"
          ? targetAgentId
          : undefined;
      const agentId =
        explicitAlternateStoreAgentId ??
        resolveSessionAgentId({
          agentId: targetAgentId ?? params.agentId,
          config: params.config,
          sessionKey,
        });
      const sessionTarget = {
        ...(params.sessionTarget ?? {
          agentId,
          sessionId: params.sessionId,
          sessionKey,
          storePath:
            params.storePath ??
            resolveSessionStorePathCore(params.config?.session?.store, {
              agentId,
            }),
        }),
      };
      const persistedEntry = await patchSessionEntryCore(
        sessionTarget,
        (entry, patchContext) => {
          if (patchContext.existingEntry && entry.sessionId !== sessionTarget.sessionId) {
            return null;
          }
          return {
            sessionId: sessionTarget.sessionId,
            updatedAt: Date.now(),
          };
        },
        {
          fallbackEntry: params.sessionEntry
            ? undefined
            : { sessionId: sessionTarget.sessionId, updatedAt: Date.now() },
          skipMaintenance: true,
        },
      );
      if (persistedEntry?.sessionId !== sessionTarget.sessionId) {
        // Skip only this stale blocked-message write; the outer runner still returns blocked.
        return;
      }
      const write = captureCliBlockFallbackWrite(sessionTarget, persistedEntry);
      const { restoreSessionColdTranscript } =
        await import("../../config/sessions/session-cold-storage.js");
      await restoreSessionColdTranscript(write.readScope, write.assertCurrent);
      await withOpenClawAgentDatabaseWrite(write.databaseOptions, () => {
        write.assertCurrent();
        const manager = SessionManager.open(write.readScope);
        manager.appendMessage(redactedUserMessage);
        manager.flushPendingPersistence();
      });
      return;
    }
    const target = sessionManager.getSessionTarget();
    const assertOwnedWrite = target ? captureOwnedTranscriptWriteAssertion(target) : undefined;
    const cliWriter = target
      ? getCliHistoryWriter({ ...target, storePath: resolveSessionTranscriptDatabasePath(target) })
      : undefined;
    await withSessionManagerWrite(sessionManager, () => {
      assertOwnedWrite?.();
      cliWriter?.assertCurrent();
      sessionManager.appendMessage(redactedUserMessage);
      sessionManager.flushPendingPersistence();
    });
  } catch (err) {
    log.warn(
      `before_agent_run block: failed to persist redacted CLI user message: ${formatErrorMessage(
        err,
      )}`,
    );
  }
}

export async function finalizeCliContextEngineTurn(params: {
  context: PreparedCliRunContext;
  historyMessages: unknown[];
  assistantText: string;
  terminalAnchor?: import("../../config/sessions/session-accessor.js").TranscriptEntryAnchor;
  output: CliOutput;
}): Promise<void> {
  const { context } = params;
  if (!context.contextEngine) {
    return;
  }

  const { params: runParams } = context;
  const admission = runParams.userTurnTranscriptRecorder?.getAdmissionReceipt();
  if (runParams.onContextEngineTurnCandidate) {
    if (admission && params.terminalAnchor) {
      runParams.onContextEngineTurnCandidate({
        boundary: { admission, terminal: params.terminalAnchor },
        sessionIdUsed: runParams.sessionId,
        sessionKey: runParams.sessionKey,
        sessionTarget: runParams.sessionTarget,
        promptError: false,
        aborted:
          params.output.terminalInterruption !== undefined ||
          runParams.abortSignal?.aborted === true,
        yieldAborted: false,
        isHeartbeat: isHeartbeatLifecycleRunKind(runParams.bootstrapContextRunKind),
        runtimeContext: {
          provider: runParams.modelProvider ?? runParams.provider,
          modelId: context.modelId,
          modelContextWindow: runParams.modelContextWindow,
          tokenBudget: context.contextWindowInfo?.tokens,
        },
      });
    }
  } else {
    const prePromptMessages = params.historyMessages.filter(isAgentMessage);
    const turnMessages: AgentMessage[] = [];
    if (context.contextEngineTurnPrompt) {
      turnMessages.push(buildCliContextEngineUserMessage(context.contextEngineTurnPrompt));
    }
    if (params.assistantText) {
      turnMessages.push(
        buildCliHookAssistantMessage({
          text: params.assistantText,
          provider: runParams.provider,
          model: context.modelId,
          usage: params.output.usage,
          stopReason: resolveCliAssistantStopReason(params.output),
        }) as AgentMessage,
      );
    }

    const contextEngineHostSupport = buildGenericCliContextEngineHostSupport({
      backendId: context.backendResolved.id,
    });
    await finalizeHarnessContextEngineTurn({
      contextEngine: context.contextEngine,
      promptError: false,
      aborted:
        params.output.terminalInterruption !== undefined || runParams.abortSignal?.aborted === true,
      yieldAborted: false,
      sessionIdUsed: runParams.sessionId,
      sessionKey: runParams.sessionKey,
      sessionTarget: runParams.sessionTarget,
      sessionFile: runParams.sessionFile,
      isHeartbeat: isHeartbeatLifecycleRunKind(runParams.bootstrapContextRunKind),
      messagesSnapshot: [...prePromptMessages, ...turnMessages],
      prePromptMessageCount: prePromptMessages.length,
      sessionManager: runParams.sessionManager,
      config: context.contextEngineConfig,
      contextEngineHostSupport,
      providerId: runParams.provider,
      modelId: context.modelId,
      runMaintenance: async (maintenanceParams) =>
        await runHarnessContextEngineMaintenance({
          ...maintenanceParams,
          onDeferredMaintenance: context.deferContextEngineDisposalUntil,
          withSessionManagerRewriteLock: async (operation) => await operation(),
        }),
      warn: (message) => log.warn(message),
    });
  }
}
