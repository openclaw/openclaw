/**
 * Bounded pre-compaction memory flush for embedded-run compaction recovery.
 *
 * The proactive auto-reply pipeline runs a silent memory flush before
 * preflight compaction (see `auto-reply/reply/agent-runner-memory.ts`).
 * Compaction recovery inside the embedded runner (provider overflow, timeout)
 * compacts the rejected session directly, so a configured memory flush never
 * runs there and durable notes are silently dropped (openclaw/openclaw#114081).
 *
 * This module implements the bounded overflow-checkpointing contract: attempt
 * the configured silent memory flush before recovery compaction only when a
 * maintenance turn is demonstrably admissible (fits the flush model's context
 * budget with the same reserve/soft headroom the proactive gate uses).
 * Otherwise keep today's behavior and record an explicit skip reason.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  readRecentSessionTranscriptActiveEvents,
  updateSessionEntry,
  upsertSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../../config/sessions/session-store-path.js";
import { selectSessionTranscriptLeafControlledPath } from "../../../config/sessions/transcript-tree.js";
import type { ContextEngineSessionTarget } from "../../../context-engine/types.js";
import { resolveMemoryFlushPlan } from "../../../plugins/memory-state.js";
import { CommandLane } from "../../../process/lanes.js";
import { log } from "../logger.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import {
  resolveRecoveryMemoryFlushDecision,
  type RecoveryMemoryFlushOutcome,
} from "./recovery-memory-flush-decision.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

/**
 * Keys stripped from the outer {@link RunEmbeddedAgentParams} before the nested
 * recovery flush maintenance turn runs. Every key here is mutable outer
 * run-state or an outer-owned callback: a tool/progress boundary in the nested
 * turn could otherwise mutate the shared object (e.g. `fastModeAutoProgressState`)
 * or surface an internal memory write into the active conversation.
 *
 * This is an explicit allowlist-of-exclusions: anything NOT listed here is
 * inherited as-is, so adding a new mutable outer-state field to
 * {@link RunEmbeddedAgentParams} requires extending this array (the regression
 * below fails closed if a shared mutable field leaks). Only the private write
 * observer (`onAgentEvent`) is re-attached after the strip.
 */
const RECOVERY_FLUSH_NESTED_RUN_OMIT_KEYS = [
  // Fast-mode shared progress state — the outer run owns this mutable object.
  "fastMode",
  "fastModeAutoProgressState",
  "fastModeStartedAtMs",
  "fastModeAutoOnSeconds",
  // Outer client/plugin tool surface — the maintenance turn only needs the
  // core memory write tool. Client-hosted tools (clientTools) are forwarded
  // verbatim and bypass the core memory-flush tool filter; a delegated
  // client-tool result can terminate the nested turn without writing memory,
  // which would otherwise stamp flush success and suppress another checkpoint
  // in this compaction cycle. clientCaps / toolBindings / runtimePluginToolGrant
  // / scheduledToolPolicy are outer initiator capabilities/authority that the
  // maintenance turn must not inherit.
  "clientTools",
  "clientCaps",
  "toolBindings",
  "runtimePluginToolGrant",
  "scheduledToolPolicy",
  // Outer delivery / progress callbacks (re-attach only onAgentEvent below).
  "onExecutionStarted",
  "onExecutionPhase",
  "onLaneWait",
  "onRunProgress",
  "onSessionIdChanged",
  "onPartialReply",
  "onAssistantMessageStart",
  "onBlockReply",
  "onBlockReplyFlush",
  "onReasoningStream",
  "onReasoningEnd",
  "onToolResult",
  "onAgentToolResult",
  "onToolStreamBoundary",
  "onUserMessagePersisted",
  "onUserMessagePersistenceInvalidated",
  "onAssistantErrorMessagePersisted",
  // Outer logical-turn ownership — the active user turn's context-engine lease
  // and attempt-facts callback must not reach the ephemeral maintenance run.
  "contextEngineLogicalTurnLease",
  "onContextEngineTurnCandidate",
  // Outer reply / delivery / lifecycle state.
  "replyOperation",
  "shouldEmitToolResult",
  "shouldEmitToolOutput",
  "userTurnTranscriptRecorder",
  "enqueue",
  "streamParams",
  "internalEvents",
  "inputProvenance",
  "ownerNumbers",
  "sourceReplyDeliveryMode",
  "taskSuggestionDeliveryMode",
  "silentReplyPromptMode",
  "deferTerminalLifecycle",
  "deferTerminalLifecycleEnd",
  "blockReplyBreak",
  "blockReplyChunking",
  "streamReasoningInNonStreamModes",
  "terminalReplyExpectation",
  "allowEmptyAssistantReplyAsSilent",
  "conversationRecall",
  "cleanupBundleMcpOnRunEnd",
  "suppressNextUserMessagePersistence",
  "suppressTranscriptOnlyAssistantPersistence",
  "suppressAssistantErrorPersistence",
] as const satisfies readonly (keyof RunEmbeddedAgentParams)[];

/** Strips every outer mutable/callback field, returning a clean base for the nested turn. */
function buildRecoveryFlushNestedRunBase(
  runParams: RunEmbeddedAgentParams,
): RunEmbeddedAgentParams {
  const base: Record<string, unknown> = { ...runParams };
  for (const key of RECOVERY_FLUSH_NESTED_RUN_OMIT_KEYS) {
    base[key] = undefined;
  }
  return base as unknown as RunEmbeddedAgentParams;
}

/**
 * Creates the canonical memory/YYYY-MM-DD.md target the same way the proactive
 * flush does, so an append-only write tool can land durable notes there.
 */
async function ensureRecoveryFlushTargetFile(params: {
  workspaceDir: string;
  relativePath: string;
}): Promise<void> {
  const { workspaceDir, relativePath } = params;
  if (!workspaceDir || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Invalid memory flush target path");
  }
  const workspaceRoot = path.resolve(workspaceDir);
  const targetPath = path.resolve(workspaceRoot, relativePath);
  const targetRelativePath = path.relative(workspaceRoot, targetPath);
  if (
    !targetRelativePath ||
    targetRelativePath.startsWith("..") ||
    path.isAbsolute(targetRelativePath)
  ) {
    throw new Error("Memory flush target path must stay inside the workspace");
  }
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const handle = await fs.promises.open(targetPath, "a");
  await handle.close();
}

function hasVisibleErrorPayloads(payloads: EmbeddedAgentRunResult["payloads"]): boolean {
  return (
    Array.isArray(payloads) &&
    payloads.some((payload) => (payload as { isError?: boolean })?.isError === true)
  );
}

/**
 * Mirrors the canonical embedded-run terminal classification
 * (`resolveTerminalStatus` in `run-entry.ts`): a maintenance turn counts as
 * failed when it surfaces an error payload OR the run metadata reports an
 * abort, error, timeout, or error stop reason — even when the payload list is
 * empty. Those outcomes must never be stamped as a completed checkpoint.
 */
function isMaintenanceTurnFailed(result: EmbeddedAgentRunResult): boolean {
  if (hasVisibleErrorPayloads(result.payloads)) {
    return true;
  }
  const meta = result.meta;
  return (
    meta.stopReason === "timeout" ||
    Boolean(meta.timeoutPhase) ||
    meta.aborted === true ||
    Boolean(meta.error) ||
    meta.stopReason === "error"
  );
}

/**
 * Renders the messages that overflowed into a bounded text snapshot for the
 * maintenance turn. Keeping only the most recent content bounds the turn and
 * preserves the durable decisions made closest to the compaction point.
 */
function renderBoundedConversationText(
  messages: EmbeddedRunAttemptResult["messagesSnapshot"] | undefined,
  maxChars: number,
): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }
  const rendered: string[] = [];
  for (const message of messages) {
    const role = message.role;
    const content = (message as { content?: unknown }).content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((part: { type?: string; text?: unknown; content?: unknown }) => {
          if (part?.type === "text" && typeof part.text === "string") {
            return part.text;
          }
          if (
            (part?.type === "tool_result" || part?.type === "toolResult") &&
            typeof part.content === "string"
          ) {
            return `[tool result] ${part.content}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (text.trim()) {
      rendered.push(`[${role}] ${text}`);
    }
  }
  if (rendered.length === 0) {
    return "";
  }
  let joined = rendered.join("\n\n");
  if (joined.length > maxChars) {
    joined = joined.slice(-maxChars);
  }
  return joined;
}

const RECOVERY_FLUSH_TAINT_TAIL_EVENTS = 200;

/**
 * Mirrors the proactive flush's turn-taint scan: walks the active transcript
 * tail to the nearest user boundary and reports whether the turn is tainted
 * (explicit `turnTainted` marker or network-sourced content).
 */
function readRecoveryFlushTurnTaint(events: readonly unknown[]): {
  boundaryFound: boolean;
  tainted: boolean;
} {
  const activeEvents = selectSessionTranscriptLeafControlledPath(events) ?? events;
  for (const event of activeEvents.toReversed()) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const message = (event as { message?: unknown }).message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role === "user") {
      return { boundaryFound: true, tainted: false };
    }
    const metadata = record["__openclaw"];
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      continue;
    }
    const openClaw = metadata as { resultContentSource?: unknown; turnTainted?: unknown };
    if (openClaw.turnTainted === true || openClaw.resultContentSource === "network") {
      return { boundaryFound: false, tainted: true };
    }
  }
  return { boundaryFound: false, tainted: false };
}

async function resolveRecoveryFlushOriginClass(input: {
  runParams: RunEmbeddedAgentParams;
  agentId?: string;
  sessionKey?: string;
  sessionId: string;
  storePath?: string;
}): Promise<"agent" | "untrusted"> {
  if (input.runParams.senderIsOwner !== true || !input.sessionKey || !input.storePath) {
    return "untrusted";
  }
  try {
    const events = readRecentSessionTranscriptActiveEvents(
      {
        agentId: input.agentId,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        storePath: input.storePath,
      },
      RECOVERY_FLUSH_TAINT_TAIL_EVENTS,
    );
    const scan = readRecoveryFlushTurnTaint(events);
    const turnTainted =
      scan.tainted || (!scan.boundaryFound && events.length >= RECOVERY_FLUSH_TAINT_TAIL_EVENTS);
    return turnTainted ? "untrusted" : "agent";
  } catch {
    return "untrusted";
  }
}

async function readMemoryFlushTargetFile(absolutePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

/**
 * Attempts the bounded pre-compaction memory flush during recovery compaction.
 *
 * The maintenance turn runs through the same embedded maintenance machinery as
 * the proactive flush, but on an ephemeral session identity: the recovery path
 * still holds the real session's command lane, so a nested run against the same
 * session would deadlock. The overflowing messages are embedded in the prompt as
 * a bounded snapshot, and `suppressCompactionRecovery` keeps the turn from
 * re-entering overflow/timeout recovery or rotating any session. If the turn
 * cannot be admitted or fails, the caller proceeds with compaction unchanged
 * and a skip reason is logged — the missing-visibility half of the bug is fixed
 * even when a checkpoint is impossible.
 */
export async function attemptRecoveryMemoryFlush(input: {
  runParams: RunEmbeddedAgentParams;
  sessionKey?: string;
  agentId?: string;
  provider: string;
  modelId: string;
  observedOverflowTokens?: number;
  contextTokenBudget?: number;
  messagesSnapshot?: EmbeddedRunAttemptResult["messagesSnapshot"];
  abortSignal?: AbortSignal;
  getActiveSession: () => { id: string; target?: ContextEngineSessionTarget };
}): Promise<RecoveryMemoryFlushOutcome> {
  const { runParams } = input;
  // Prefer the runner-resolved session key (derived from the explicit key,
  // session target, or session id) so a target-only identity still resolves
  // the active store; fall back to the raw optional key for defensive callers.
  const sessionKey = input.sessionKey ?? runParams.sessionKey;
  const sessionTarget = input.getActiveSession().target;
  const storePath = sessionKey
    ? resolveSessionStorePathForScope({
        sessionKey,
        storePath: sessionTarget?.storePath,
        agentId: input.agentId,
      })
    : undefined;
  const entry = sessionKey && storePath ? loadSessionEntry({ storePath, sessionKey }) : undefined;
  // Honor the runtime sandbox policy key: direct-message policy
  // deliberately separates sandboxSessionKey from the transcript sessionKey,
  // so the sandbox writability gate must evaluate the policy identity while
  // the incognito check still uses the transcript key.
  const plan = resolveMemoryFlushPlan({ cfg: runParams.config });
  const decision = resolveRecoveryMemoryFlushDecision({
    cfg: runParams.config ?? {},
    sessionKey,
    sandboxPolicySessionKey: runParams.sandboxSessionKey,
    agentId: input.agentId,
    provider: input.provider,
    modelId: input.modelId,
    trigger: runParams.trigger,
    plan,
    entry,
    observedOverflowTokens: input.observedOverflowTokens,
    contextTokenBudget: input.contextTokenBudget,
  });
  if (decision.action === "skip") {
    log.warn(
      `[memory-flush-skip] sessionKey=${sessionKey ?? "unknown"} ` +
        `provider=${input.provider}/${input.modelId} reason=${decision.reason}`,
    );
    return { action: "skipped", reason: decision.reason };
  }

  if (!runParams.workspaceDir || !plan) {
    log.warn(
      `[memory-flush-skip] sessionKey=${sessionKey ?? "unknown"} ` +
        `reason=missing_workspace_or_plan`,
    );
    return { action: "skipped", reason: "missing_workspace_or_plan" };
  }

  const flushRunId = crypto.randomUUID();
  const agentId = input.agentId ?? runParams.agentId ?? "main";
  const flushSystemPrompt = [runParams.extraSystemPrompt, plan.systemPrompt]
    .filter((text): text is string => Boolean(text))
    .join("\n\n");
  const conversationText = renderBoundedConversationText(input.messagesSnapshot, 32_000);
  const flushPrompt = [
    plan.prompt,
    conversationText ? `\n\nConversation snapshot:\n${conversationText}` : "",
  ].join("");
  const flushSessionKey = `agent:${agentId}:flush-${flushRunId}`;
  // Guard the executor before any persistent setup: an unavailable executor
  // must leave recovery unchanged (no blank memory target, no orphan flush
  // session), exactly like the proactive flush's no-plan skip.
  const runRecoveryMemoryFlushTurn = runParams.runRecoveryMemoryFlushTurn;
  if (!runRecoveryMemoryFlushTurn) {
    log.warn(
      `[memory-flush-skip] sessionKey=${sessionKey ?? "unknown"} ` +
        `reason=recovery_flush_executor_unavailable`,
    );
    return { action: "skipped", reason: "recovery_flush_executor_unavailable" };
  }
  let flushSessionCreated = false;
  try {
    await ensureRecoveryFlushTargetFile({
      workspaceDir: runParams.workspaceDir,
      relativePath: plan.relativePath,
    });
    const memoryFlushAbsolutePath = path.join(runParams.workspaceDir, plan.relativePath);
    const memoryFlushContentBefore = await readMemoryFlushTargetFile(memoryFlushAbsolutePath);
    let memoryFlushWroteTarget = false;
    // The maintenance turn runs on an ephemeral session (own command lane) so it
    // cannot deadlock against the real session's lane, which recovery still
    // holds. Pre-create the session entry so the run can persist its transcript
    // header; trajectory persistence stays disabled to keep the store clean.
    if (storePath) {
      await upsertSessionEntry(
        { storePath, sessionKey: flushSessionKey, agentId },
        { sessionId: flushRunId },
      );
      flushSessionCreated = true;
    }
    // The ephemeral flush session must stay in the active session's store:
    // the entry is pre-created (and later cleaned up) at `storePath`, so the
    // nested run has to resolve the same store instead of falling back to the
    // default SQLite store. Carry an ephemeral typed target with that path.
    const ephemeralFlushSessionTarget = storePath
      ? {
          agentId,
          sessionId: flushRunId,
          sessionKey: flushSessionKey,
          storePath,
        }
      : undefined;
    const nestedRunParams: RunEmbeddedAgentParams = {
      ...buildRecoveryFlushNestedRunBase(runParams),
      // Ephemeral flush-run identity: never inherit the outer session's
      // manager/file/transcript. The nested run opens its own ephemeral
      // manager on the typed target above.
      runId: flushRunId,
      sessionId: flushRunId,
      sessionKey: flushSessionKey,
      sessionManager: undefined,
      sessionTarget: ephemeralFlushSessionTarget,
      sessionFile: undefined,
      // Flush-turn-specific inputs. Everything else either comes from the
      // outer run (immutable config, workspace, sandbox identity) or was
      // stripped by buildRecoveryFlushNestedRunBase (mutable outer state and
      // callbacks). Only the private write observer is re-attached.
      provider: decision.provider,
      model: decision.model,
      modelFallbacksOverride: [],
      prompt: flushPrompt,
      transcriptPrompt: "",
      extraSystemPrompt: flushSystemPrompt,
      silentExpected: true,
      trigger: "memory",
      memoryFlushWritePath: plan.relativePath,
      lane: CommandLane.Nested,
      suppressCompactionRecovery: true,
      disableTrajectory: true,
      abortSignal: input.abortSignal,
      onAgentEvent: (evt) => {
        if (
          evt.stream === "tool" &&
          evt.data.name === "write" &&
          evt.data.phase === "result" &&
          evt.data.isError !== true
        ) {
          memoryFlushWroteTarget = true;
        }
      },
    };
    const result = await runRecoveryMemoryFlushTurn(nestedRunParams);
    if (isMaintenanceTurnFailed(result)) {
      log.warn(
        `[memory-flush-skip] sessionKey=${sessionKey ?? "unknown"} ` +
          `provider=${decision.provider}/${decision.model} reason=maintenance_turn_failed`,
      );
      return { action: "skipped", reason: "maintenance_turn_failed" };
    }
    // A delegated client-tool terminal result (or any turn that completed
    // without invoking the core `write` tool) is not a failed maintenance
    // turn, but it also wrote no memory. Stamping it as a successful flush
    // would suppress another checkpoint in this compaction cycle while the
    // durable note is silently lost — the exact symptom this PR fixes. Treat
    // a no-write completion as a skip so the recovery compact+retry default
    // stays intact and the skip reason is visible in the gateway log.
    if (!memoryFlushWroteTarget) {
      log.warn(
        `[memory-flush-skip] sessionKey=${sessionKey ?? "unknown"} ` +
          `provider=${decision.provider}/${decision.model} reason=no_memory_written`,
      );
      return { action: "skipped", reason: "no_memory_written" };
    }
    if (memoryFlushWroteTarget && plan.recordWriteProvenance) {
      try {
        const originClass = await resolveRecoveryFlushOriginClass({
          runParams,
          agentId,
          sessionKey,
          sessionId: input.getActiveSession().id,
          storePath,
        });
        await plan.recordWriteProvenance({
          workspaceDir: runParams.workspaceDir,
          relativePath: plan.relativePath,
          contentBefore: memoryFlushContentBefore,
          contentAfter: await readMemoryFlushTargetFile(memoryFlushAbsolutePath),
          originClass,
          observedAt: Date.now(),
        });
      } catch (err) {
        log.warn(
          `failed to record recovery memory flush provenance: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } catch (err) {
    log.warn(
      `[memory-flush-skip] sessionKey=${sessionKey ?? "unknown"} ` +
        `provider=${decision.provider}/${decision.model} reason=maintenance_turn_failed ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    return { action: "skipped", reason: "maintenance_turn_failed" };
  } finally {
    // The ephemeral flush session exists only so the maintenance turn can
    // persist its transcript header. Remove it on every outcome so an admitted
    // checkpoint never leaves durable session-state debris behind.
    if (flushSessionCreated && storePath) {
      try {
        await deleteSessionEntryLifecycle({
          storePath,
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
          target: { storeKeys: [flushSessionKey], canonicalKey: flushSessionKey },
          requireWriteSuccess: false,
        });
      } catch (cleanupErr) {
        log.warn(
          `failed to clean up recovery flush session ${flushSessionKey}: ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }
  }

  const flushedCompactionCount = entry?.compactionCount ?? 0;
  if (sessionKey && storePath) {
    try {
      await updateSessionEntry(
        { storePath, sessionKey },
        () => ({ memoryFlush: { kind: "succeeded", compactionCount: flushedCompactionCount } }),
        { skipMaintenance: true, takeCacheOwnership: true },
      );
    } catch (err) {
      log.warn(
        `failed to persist recovery memory flush metadata: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  log.info(
    `[memory-flush] pre-compaction checkpoint completed during recovery ` +
      `sessionKey=${sessionKey ?? "unknown"} ` +
      `provider=${decision.provider}/${decision.model} ` +
      `window=${decision.contextWindowTokens}`,
  );
  return { action: "flushed" };
}
