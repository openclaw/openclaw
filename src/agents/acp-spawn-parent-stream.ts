import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { type DeliveryReceiptTarget, recordReceipt } from "../infra/outbound/delivery-receipts.js";
import type { MessageClass } from "../infra/outbound/message-class.js";
import { sendMessage } from "../infra/outbound/message.js";
import { planDelivery, type ResolvedSurfaceTarget } from "../infra/outbound/surface-policy.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { scopedHeartbeatWakeOptions } from "../routing/session-key.js";
import { normalizeAssistantPhase } from "../shared/chat-message-content.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeAssistantVisibleTextWithProfile } from "../shared/text/assistant-visible-text.js";
import { recordTaskRunProgressByRunId } from "../tasks/task-executor.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

const relayLog = createSubsystemLogger("agents/acp-spawn-parent-stream");

// Phase 3 Discord Surface Overhaul: sanitizer profile selection for outbound
// emissions. `final_reply` uses the canonical delivery profile; `progress`
// uses the stricter leak-scrub profile that also strips absolute paths,
// redacts sk-*/Bearer tokens, and removes stack-trace frames. Non-prose
// classes (completion, internal_narration, etc.) do not pass through the
// sanitizer because they are either system-generated strings or suppressed.
// Phase 9 P2 Discord Surface Overhaul: when the parent-stream relay decides to
// suppress an emission (via `planDelivery`), push a machine-readable
// `delivery_outcome` event back to the ORIGINATING child session. Class is
// always `internal_narration` so the event never leaks to any user-facing
// surface; it becomes part of the child's next prompt prefix.
function emitDeliveryOutcomeSystemEvent(params: {
  childSessionKey: string;
  decision: "suppress";
  reason?: string;
  originalMessageClass: MessageClass;
  target: { channel: string; to: string; accountId?: string; threadId?: string | number };
}): void {
  if (!params.childSessionKey) {
    return;
  }
  const payload = {
    kind: "delivery_outcome",
    decision: params.decision,
    ...(params.reason ? { reason: params.reason } : {}),
    originalMessageClass: params.originalMessageClass,
    target: params.target,
  };
  const text = `[delivery_outcome] ${JSON.stringify(payload)}`;
  enqueueSystemEvent(text, {
    sessionKey: params.childSessionKey,
    contextKey: `delivery_outcome:${params.originalMessageClass}:${params.reason ?? "unknown"}`,
    messageClass: "internal_narration",
    trusted: false,
  });
}

function sanitizeEmissionText(text: string, messageClass: MessageClass): string {
  if (messageClass === "final_reply") {
    return sanitizeAssistantVisibleTextWithProfile(text, "delivery");
  }
  if (messageClass === "progress") {
    return sanitizeAssistantVisibleTextWithProfile(text, "progress");
  }
  return text;
}

const DEFAULT_STREAM_FLUSH_MS = 2_500;
const DEFAULT_NO_OUTPUT_NOTICE_MS = 60_000;
const DEFAULT_NO_OUTPUT_POLL_MS = 15_000;
const DEFAULT_MAX_RELAY_LIFETIME_MS = 6 * 60 * 60 * 1000;
const STREAM_BUFFER_MAX_CHARS = 4_000;
const STREAM_SNIPPET_MAX_CHARS = 220;
// Discord hard-limits a single message to 2000 chars; webhook execute posts
// reject longer bodies. We split final_reply bodies under this to keep the
// webhook identity path functional for long assistant replies. Conservative
// headroom under Discord's 2000-char limit to tolerate mention rewrites.
const DIRECT_POST_CHUNK_MAX_CHARS = 1_900;

// Phase 2 Discord Surface Overhaul: provider-agnostic allowlists describing
// which streams the relay is allowed to surface to the parent session. Events
// from streams NOT in either allowlist are treated as internal_narration (the
// safe default) and short-circuited before `enqueueSystemEvent` allocates.
const KNOWN_ASSISTANT_STREAMS = new Set<string>(["assistant", "output"]);
const KNOWN_LIFECYCLE_STREAMS = new Set<string>(["lifecycle"]);

// Classify an agent-event stream emission into a MessageClass using ONLY
// stream-name + lifecycle phase + assistant phase. Provider-specific quirks
// (e.g. Codex's multi-agentMessage turns) are delegated to extension-owned
// classifiers at the call site; this helper defines the provider-agnostic
// safety net.
export function classifyRelayStreamEmission(params: {
  stream: string;
  assistantPhase?: "commentary" | "final_answer";
  lifecyclePhase?: "start" | "running" | "resumed" | "end" | "error" | "timeout" | (string & {});
}): MessageClass {
  if (KNOWN_ASSISTANT_STREAMS.has(params.stream)) {
    // Assistant deltas for an intermediate/commentary phase are progress; a
    // terminal final_answer phase is final_reply. When the upstream phase is
    // not set we assume a mid-turn delta, i.e. progress.
    if (params.assistantPhase === "final_answer") {
      return "final_reply";
    }
    return "progress";
  }
  if (KNOWN_LIFECYCLE_STREAMS.has(params.stream)) {
    if (params.lifecyclePhase === "end" || params.lifecyclePhase === "error") {
      return "completion";
    }
    return "progress";
  }
  // Unknown stream: never surface to a user channel.
  return "internal_narration";
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

// Count non-overlapping occurrences of the literal fence marker ``` in `value`.
function countTripleBackticks(value: string): number {
  let count = 0;
  let idx = value.indexOf("```");
  while (idx !== -1) {
    count += 1;
    idx = value.indexOf("```", idx + 3);
  }
  return count;
}

// Split a long final_reply body into chunks that fit under Discord's 2000-char
// message limit. Prefers paragraph boundaries ("\n\n"), then line boundaries,
// then word boundaries, and finally a hard slice when a single word exceeds the
// chunk budget. Returns [] for empty input (callers must fall back to the
// enqueue path so empty text is not recorded as a delivered receipt). Chunks
// are trimmed of trailing whitespace but internal newlines are preserved so
// the assistant's formatting survives across splits. When a triple-backtick
// code fence straddles a chunk boundary we append `\n\`\`\`` to the current
// chunk and prepend ``` \n `` to the next so each chunk renders as valid
// Markdown on Discord. Single-backtick, bold/italic, and strikethrough runs
// are NOT fixed up — known limitation documented on the call site.
export function splitLongFinalReply(
  text: string,
  maxChars: number = DIRECT_POST_CHUNK_MAX_CHARS,
): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const body = text ?? "";
  // MUST-FIX #1: empty body must return [] (not [body]) so the direct-post
  // caller knows to fall back to enqueue instead of recording a spurious
  // "delivered" receipt for no-op dispatch.
  if (!body) {
    return [];
  }
  if (body.length <= limit) {
    return [body];
  }
  const chunks: string[] = [];
  let remaining = body;
  let carryPrefix = "";
  while (remaining.length > limit) {
    // Prefer a paragraph break ("\n\n") within the budget; fall back to the
    // last newline, then the last whitespace, then a hard slice.
    const window = remaining.slice(0, limit);
    let splitAt = window.lastIndexOf("\n\n");
    if (splitAt <= 0) {
      splitAt = window.lastIndexOf("\n");
    }
    if (splitAt <= 0) {
      const lastSpace = window.lastIndexOf(" ");
      if (lastSpace > 0) {
        splitAt = lastSpace;
      }
    }
    if (splitAt <= 0) {
      splitAt = limit;
    }
    let head = remaining.slice(0, splitAt).replace(/\s+$/, "");
    let nextCarry = "";
    // SHOULD-FIX #3: if the current head has an odd count of ``` fences, the
    // code block is open at the cut point. Close it here and reopen it on the
    // next chunk so both chunks render as valid Markdown.
    const combinedHead = `${carryPrefix}${head}`;
    if (countTripleBackticks(combinedHead) % 2 === 1) {
      head = `${head}\n\`\`\``;
      nextCarry = "```\n";
    }
    if (carryPrefix || head) {
      chunks.push(`${carryPrefix}${head}`);
    }
    carryPrefix = nextCarry;
    remaining = remaining.slice(splitAt).replace(/^\s+/, "");
  }
  if (remaining) {
    chunks.push(`${carryPrefix}${remaining}`);
  } else if (carryPrefix) {
    chunks.push(carryPrefix);
  }
  return chunks;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveAcpStreamLogPathFromSessionFile(sessionFile: string, sessionId: string): string {
  const baseDir = path.dirname(path.resolve(sessionFile));
  return path.join(baseDir, `${sessionId}.acp-stream.jsonl`);
}

export function resolveAcpSpawnStreamLogPath(params: {
  childSessionKey: string;
}): string | undefined {
  const childSessionKey = normalizeOptionalString(params.childSessionKey);
  if (!childSessionKey) {
    return undefined;
  }
  const storeEntry = readAcpSessionEntry({
    sessionKey: childSessionKey,
  });
  const sessionId = normalizeOptionalString(storeEntry?.entry?.sessionId);
  if (!storeEntry || !sessionId) {
    return undefined;
  }
  try {
    const sessionFile = resolveSessionFilePath(
      sessionId,
      storeEntry.entry,
      resolveSessionFilePathOptions({
        storePath: storeEntry.storePath,
      }),
    );
    return resolveAcpStreamLogPathFromSessionFile(sessionFile, sessionId);
  } catch {
    return undefined;
  }
}

export function startAcpSpawnParentStreamRelay(params: {
  runId: string;
  parentSessionKey: string;
  childSessionKey: string;
  agentId: string;
  logPath?: string;
  deliveryContext?: DeliveryContext;
  surfaceUpdates?: boolean;
  streamFlushMs?: number;
  noOutputNoticeMs?: number;
  noOutputPollMs?: number;
  maxRelayLifetimeMs?: number;
  emitStartNotice?: boolean;
}): AcpSpawnParentRelayHandle {
  const runId = normalizeOptionalString(params.runId) ?? "";
  const parentSessionKey = normalizeOptionalString(params.parentSessionKey) ?? "";
  if (!runId || !parentSessionKey) {
    return {
      dispose: () => {},
      notifyStarted: () => {},
    };
  }

  const streamFlushMs =
    typeof params.streamFlushMs === "number" && Number.isFinite(params.streamFlushMs)
      ? Math.max(0, Math.floor(params.streamFlushMs))
      : DEFAULT_STREAM_FLUSH_MS;
  const noOutputNoticeMs =
    typeof params.noOutputNoticeMs === "number" && Number.isFinite(params.noOutputNoticeMs)
      ? Math.max(0, Math.floor(params.noOutputNoticeMs))
      : DEFAULT_NO_OUTPUT_NOTICE_MS;
  const noOutputPollMs =
    typeof params.noOutputPollMs === "number" && Number.isFinite(params.noOutputPollMs)
      ? Math.max(250, Math.floor(params.noOutputPollMs))
      : DEFAULT_NO_OUTPUT_POLL_MS;
  const maxRelayLifetimeMs =
    typeof params.maxRelayLifetimeMs === "number" && Number.isFinite(params.maxRelayLifetimeMs)
      ? Math.max(1_000, Math.floor(params.maxRelayLifetimeMs))
      : DEFAULT_MAX_RELAY_LIFETIME_MS;

  const relayLabel = truncate(compactWhitespace(params.agentId), 40) || "ACP child";
  const contextPrefix = `acp-spawn:${runId}`;
  const logPath = normalizeOptionalString(params.logPath);
  let logDirReady = false;
  let pendingLogLines = "";
  let logFlushScheduled = false;
  let logWriteChain: Promise<void> = Promise.resolve();
  const flushLogBuffer = () => {
    if (!logPath || !pendingLogLines) {
      return;
    }
    const chunk = pendingLogLines;
    pendingLogLines = "";
    logWriteChain = logWriteChain
      .then(async () => {
        if (!logDirReady) {
          await mkdir(path.dirname(logPath), {
            recursive: true,
          });
          logDirReady = true;
        }
        await appendFile(logPath, chunk, {
          encoding: "utf-8",
          mode: 0o600,
        });
      })
      .catch(() => {
        // Best-effort diagnostics; never break relay flow.
      });
  };
  const scheduleLogFlush = () => {
    if (!logPath || logFlushScheduled) {
      return;
    }
    logFlushScheduled = true;
    queueMicrotask(() => {
      logFlushScheduled = false;
      flushLogBuffer();
    });
  };
  const writeLogLine = (entry: Record<string, unknown>) => {
    if (!logPath) {
      return;
    }
    try {
      pendingLogLines += `${JSON.stringify(entry)}\n`;
      if (pendingLogLines.length >= 16_384) {
        flushLogBuffer();
        return;
      }
      scheduleLogFlush();
    } catch {
      // Best-effort diagnostics; never break relay flow.
    }
  };
  const logEvent = (kind: string, fields?: Record<string, unknown>) => {
    writeLogLine({
      ts: new Date().toISOString(),
      epochMs: Date.now(),
      runId,
      parentSessionKey,
      childSessionKey: params.childSessionKey,
      agentId: params.agentId,
      kind,
      ...fields,
    });
  };
  const shouldSurfaceUpdates = params.surfaceUpdates !== false;
  const wake = () => {
    if (!shouldSurfaceUpdates) {
      return;
    }
    requestHeartbeatNow(
      scopedHeartbeatWakeOptions(parentSessionKey, {
        reason: "acp:spawn:stream",
      }),
    );
  };
  // Whether the parent session is bound to a thread/topic surface (e.g. a
  // Discord thread). Thread-bound surfaces are the main leak vector for
  // internal narration; short-circuit there to skip the enqueue allocation
  // entirely. Outside thread-bound surfaces the classifier still suppresses
  // internal_narration via the surface-policy predicate, but we let it flow
  // through so the legacy session-queue behavior is preserved on main surfaces.
  const threadBound = Boolean(params.deliveryContext?.threadId);

  // F3 (Phase 3.5 Discord Surface Overhaul): when the relay has a thread-bound
  // delivery context AND the emission class is `final_reply`, POST the text
  // directly into the thread instead of queuing it as a system event on the
  // parent prompt. Without this branch, the "final answer" ends up spliced
  // into the parent's NEXT turn as a `System:` line (see
  // `drainFormattedSystemEvents`) — the user never sees it in the thread.
  // Fires a void promise; errors are logged at warn and do NOT block the
  // subscriber (sync) caller.
  //
  // Ownership contract: when this function returns `true` it takes full
  // responsibility for recording the delivery receipt (including partial-
  // delivery outcomes). Callers must NOT record their own receipt in that
  // branch, or receipts would be double-counted. Returning `false` means the
  // caller should fall through to the enqueue+receipt path.
  const directPostFinalReply = (
    text: string,
    contextKey: string,
    messageClass: MessageClass,
    target: DeliveryReceiptTarget,
    resolvedContextAt: number,
  ): boolean => {
    if (!threadBound || messageClass !== "final_reply") {
      return false;
    }
    const ctx = params.deliveryContext;
    if (!ctx?.channel || !ctx?.to) {
      return false;
    }
    // Plan delivery via the central policy so suppression/reroute semantics
    // stay consistent with other outbound surfaces (currently `deliver`).
    const surface: ResolvedSurfaceTarget = {
      channel: ctx.channel,
      to: ctx.to,
      ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
      ...(ctx.threadId != null ? { threadId: ctx.threadId } : {}),
    };
    const decision = planDelivery({
      messageClass,
      surface: ctx,
    });
    if (decision.outcome !== "deliver") {
      // Respect operator_only/silent/internal suppression even on the
      // direct-POST fast path. Fall back to enqueue so legacy policy wins.
      return false;
    }
    // Discord hard-rejects single webhook messages > 2000 chars. The webhook
    // path in the discord plugin does NOT pre-chunk, so long assistant replies
    // would silently fail here. Split across sequential sends, preserving
    // paragraph/line boundaries where possible. Short replies take the
    // single-send fast path below.
    const chunks = splitLongFinalReply(text, DIRECT_POST_CHUNK_MAX_CHARS);
    // MUST-FIX #1: empty body → no chunks → fall through to enqueue path so
    // the caller does not record a "delivered" receipt for a no-op dispatch.
    if (chunks.length === 0) {
      return false;
    }
    const threadIdForPost = ctx.threadId;
    const threadOption =
      typeof threadIdForPost === "number"
        ? { threadId: threadIdForPost }
        : typeof threadIdForPost === "string" && threadIdForPost
          ? { threadId: threadIdForPost }
          : {};
    // SHOULD-FIX #2: on per-chunk failure, keep going so a single transient
    // 429 does not truncate the entire reply. Record a receipt whose reason
    // tag reflects partial delivery; operators get the specific chunk index
    // in relayLog.warn.
    const dispatch = async () => {
      const totalChunks = chunks.length;
      let deliveredCount = 0;
      const failedIndices: number[] = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (!chunk) {
          continue;
        }
        try {
          await sendMessage({
            channel: surface.channel,
            to: surface.to,
            content: chunk,
            accountId: surface.accountId,
            ...threadOption,
            bestEffort: true,
          });
          deliveredCount += 1;
        } catch (err: unknown) {
          failedIndices.push(i + 1);
          relayLog.warn("acp-spawn parent-stream direct final_reply chunk post failed", {
            runId,
            parentSessionKey,
            contextKey,
            channel: surface.channel,
            threadId: threadIdForPost,
            chunkIndex: i + 1,
            totalChunks,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const reason =
        failedIndices.length === 0
          ? "direct_post_final_reply"
          : deliveredCount === 0
            ? "direct_post_final_reply_all_failed"
            : "direct_post_final_reply_partial";
      recordReceipt(parentSessionKey, {
        target,
        messageClass,
        outcome: deliveredCount > 0 ? "delivered" : "suppressed",
        reason,
        ts: Date.now(),
        resolvedContextAt,
      });
      if (deliveredCount > 0) {
        wake();
      }
    };
    void dispatch().catch((err: unknown) => {
      relayLog.warn("acp-spawn parent-stream direct final_reply post failed", {
        runId,
        parentSessionKey,
        contextKey,
        channel: surface.channel,
        threadId: threadIdForPost,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    return true;
  };

  const emit = (text: string, contextKey: string, messageClass: MessageClass) => {
    const cleaned = text.trim();
    if (!cleaned) {
      return;
    }
    logEvent("system_event", { contextKey, text: cleaned, messageClass });
    if (!shouldSurfaceUpdates) {
      return;
    }
    // Short-circuit for thread-bound surfaces: internal narration must never
    // reach the thread, and skipping the enqueue avoids hot-path allocation
    // that would only be suppressed by the surface-policy predicate later.
    if (threadBound && messageClass === "internal_narration") {
      return;
    }
    // Phase 3 Discord Surface Overhaul: sanitize text bound for user-facing
    // surfaces. `progress` uses the stricter leak-scrub profile; `final_reply`
    // uses the delivery profile; other classes fall through unchanged because
    // they are either system-generated (completion banners, boot strings) or
    // will be suppressed by the surface-policy predicate downstream.
    const sanitized = sanitizeEmissionText(cleaned, messageClass);
    const payload = sanitized.trim() || cleaned; // never deliver empty text
    const resolvedContextAt = Date.now();
    const ctx = params.deliveryContext;
    const target =
      ctx?.channel && ctx?.to
        ? {
            channel: ctx.channel,
            to: ctx.to,
            ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
            ...(ctx.threadId != null ? { threadId: ctx.threadId } : {}),
          }
        : { channel: "unknown", to: "unknown" };
    // Phase 9: plan the delivery ONCE here so we can branch on the outcome and
    // record a receipt for both directions (deliver/suppress). We ONLY call
    // planDelivery when a concrete delivery context is present — absent one,
    // legacy behavior is to enqueue into the parent's prompt prefix (the
    // session-queue surface), which is not an origin-respect violation because
    // it never reaches an external user-facing channel.
    const hasContext = Boolean(ctx?.channel && ctx?.to);
    const plan = hasContext
      ? planDelivery({ messageClass, surface: ctx ?? { channel: "", to: "" } })
      : ({ outcome: "deliver" } as const);
    if (plan.outcome === "suppress") {
      recordReceipt(parentSessionKey, {
        target,
        messageClass,
        outcome: "suppressed",
        reason: plan.reason,
        ts: Date.now(),
        resolvedContextAt,
      });
      // Phase 9 P2: surface a `delivery_outcome` system event back to the
      // originating child session so the child can see its own fate without
      // polling. Class `internal_narration` guarantees it won't leak to any
      // user-visible surface.
      emitDeliveryOutcomeSystemEvent({
        childSessionKey: params.childSessionKey,
        originalMessageClass: messageClass,
        decision: "suppress",
        reason: plan.reason,
        target,
      });
      return;
    }
    // directPostFinalReply owns the receipt (sync true-return means it will
    // record the receipt inside its async dispatcher — see ownership contract
    // on the function). Do NOT record a receipt here in that branch.
    if (directPostFinalReply(payload, contextKey, messageClass, target, resolvedContextAt)) {
      return;
    }
    enqueueSystemEvent(payload, {
      sessionKey: parentSessionKey,
      contextKey,
      deliveryContext: params.deliveryContext,
      trusted: false,
      messageClass,
    });
    recordReceipt(parentSessionKey, {
      target,
      messageClass,
      outcome: "delivered",
      reason: "queued_system_event",
      ts: Date.now(),
      resolvedContextAt,
    });
    wake();
  };
  const emitStartNotice = () => {
    recordTaskRunProgressByRunId({
      runId,
      runtime: "acp",
      sessionKey: params.childSessionKey,
      lastEventAt: Date.now(),
      eventSummary: "Started.",
    });
    // "Started ..." is a lifecycle-start progress notice, not a user reply.
    emit(
      `Started ${relayLabel} session ${params.childSessionKey}. Streaming progress updates to parent session.`,
      `${contextPrefix}:start`,
      classifyRelayStreamEmission({ stream: "lifecycle", lifecyclePhase: "start" }),
    );
  };

  let disposed = false;
  let pendingText = "";
  let lastProgressAt = Date.now();
  let stallNotified = false;
  let flushTimer: NodeJS.Timeout | undefined;
  let relayLifetimeTimer: NodeJS.Timeout | undefined;

  const clearFlushTimer = () => {
    if (!flushTimer) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };
  const clearRelayLifetimeTimer = () => {
    if (!relayLifetimeTimer) {
      return;
    }
    clearTimeout(relayLifetimeTimer);
    relayLifetimeTimer = undefined;
  };

  // The most-recent assistant-phase seen for the active delta buffer. When
  // flushPending runs, we use this to distinguish intermediate progress from a
  // final_reply snippet. Reset after each flush so a subsequent commentary
  // pass doesn't accidentally carry over a stale `final_answer` class.
  let pendingAssistantPhase: "commentary" | "final_answer" | undefined;
  // G5a (R2 fix, Phase 10 Discord Surface Overhaul): Claude ACP deltas omit
  // the assistant `phase` field entirely. When the scheduleFlush timer
  // (DEFAULT_STREAM_FLUSH_MS = 2500ms) fires before lifecycle-end arrives
  // (which can be 14+ seconds later), the buffered assistant text ships as
  // `progress` and the subsequent terminal flushPending({ terminal: true })
  // has nothing left to promote to final_reply. Result: Claude's final reply
  // reaches the thread but is classified as progress and loses webhook-
  // identity routing.
  //
  // Fix: track whether ANY delta in the current stream has carried an
  // explicit phase. If not, treat the stream as "phase-less" (Claude-style)
  // and defer timer-initiated flushes — let lifecycle-end be the terminal
  // trigger. The existing STREAM_BUFFER_MAX_CHARS truncation bounds memory
  // growth while we wait. If a phase is observed later, the flag flips and
  // normal timer flushing resumes.
  let observedExplicitPhase = false;
  // F4 (Phase 2.5 Discord Surface Overhaul): when lifecycle `phase="end"`
  // fires with buffered assistant text AND no explicit assistant phase was
  // observed (Claude ACP deltas omit `phase`), promote the terminal flush to
  // `final_reply`. This matches observed upstream behavior: the last
  // agentMessage chunk carries the user-visible answer. Without the promotion
  // every delta — including the terminal one — would ship as `progress`,
  // leaving the final answer invisible on thread surfaces.
  const flushPending = (options?: { terminal?: boolean }) => {
    clearFlushTimer();
    if (!pendingText) {
      return;
    }
    const buffered = pendingText;
    const phase = pendingAssistantPhase;
    pendingText = "";
    pendingAssistantPhase = undefined;
    const effectivePhase: "commentary" | "final_answer" | undefined =
      options?.terminal && phase !== "commentary" ? "final_answer" : phase;
    const messageClass = classifyRelayStreamEmission({
      stream: "assistant",
      assistantPhase: effectivePhase,
    });
    // Invariants:
    //   - final_reply: preserve the full buffered text verbatim (trimmed,
    //     newlines intact); no relay-label prefix (webhook persona conveys it).
    //   - progress: label-prefixed snippet capped at STREAM_SNIPPET_MAX_CHARS
    //     so parent session-queue summaries stay compact.
    const body =
      messageClass === "final_reply"
        ? buffered.trim()
        : `${relayLabel}: ${truncate(compactWhitespace(buffered), STREAM_SNIPPET_MAX_CHARS)}`;
    if (!body) {
      return;
    }
    const contextKey =
      messageClass === "final_reply" ? `${contextPrefix}:final_reply` : `${contextPrefix}:progress`;
    emit(body, contextKey, messageClass);
  };

  const scheduleFlush = () => {
    if (disposed || flushTimer || streamFlushMs <= 0) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      // G5a: if no assistant delta has ever carried an explicit phase, this
      // stream is Claude-style — defer to lifecycle-end for terminal framing
      // so the buffer gets promoted to final_reply instead of shipping as
      // intermediate progress. Rescheduling keeps the timer alive in case a
      // phase arrives later and we return to normal flushing behavior.
      if (!observedExplicitPhase && pendingText) {
        scheduleFlush();
        return;
      }
      flushPending();
    }, streamFlushMs);
    flushTimer.unref?.();
  };

  const noOutputWatcherTimer = setInterval(() => {
    if (disposed || noOutputNoticeMs <= 0) {
      return;
    }
    if (stallNotified) {
      return;
    }
    if (Date.now() - lastProgressAt < noOutputNoticeMs) {
      return;
    }
    stallNotified = true;
    recordTaskRunProgressByRunId({
      runId,
      runtime: "acp",
      sessionKey: params.childSessionKey,
      lastEventAt: Date.now(),
      eventSummary: `No output for ${Math.round(noOutputNoticeMs / 1000)}s. It may be waiting for input.`,
    });
    // Stall notices are lifecycle-progress class — the child is still running,
    // just quiet. Classify explicitly so the surface-policy predicate can
    // route it per notifyPolicy.
    emit(
      `${relayLabel} has produced no output for ${Math.round(noOutputNoticeMs / 1000)}s. It may be waiting for interactive input.`,
      `${contextPrefix}:stall`,
      classifyRelayStreamEmission({ stream: "lifecycle", lifecyclePhase: "running" }),
    );
  }, noOutputPollMs);
  noOutputWatcherTimer.unref?.();

  relayLifetimeTimer = setTimeout(() => {
    if (disposed) {
      return;
    }
    // SHOULD-FIX #4: drain the pending buffer as final_reply BEFORE dispose
    // so the user does not silently lose the last partial answer when a
    // phase-less stream times out without a clean lifecycle-end.
    flushPending({ terminal: true });
    // Relay lifetime timeout is terminal — classify as completion so the
    // surface-policy predicate treats it like a lifecycle end.
    emit(
      `${relayLabel} stream relay timed out after ${Math.max(1, Math.round(maxRelayLifetimeMs / 1000))}s without completion.`,
      `${contextPrefix}:timeout`,
      classifyRelayStreamEmission({ stream: "lifecycle", lifecyclePhase: "end" }),
    );
    dispose();
  }, maxRelayLifetimeMs);
  relayLifetimeTimer.unref?.();

  if (params.emitStartNotice !== false) {
    emitStartNotice();
  }

  const unsubscribe = onAgentEvent((event) => {
    if (disposed || event.runId !== runId) {
      return;
    }

    if (event.stream === "assistant") {
      const data = event.data;
      const assistantPhase = normalizeAssistantPhase(
        (data as { phase?: unknown } | undefined)?.phase,
      );
      const deltaCandidate =
        (data as { delta?: unknown } | undefined)?.delta ??
        (data as { text?: unknown } | undefined)?.text;
      const delta = typeof deltaCandidate === "string" ? deltaCandidate : undefined;
      if (!delta || !delta.trim()) {
        return;
      }
      logEvent("assistant_delta", {
        delta,
        ...(assistantPhase ? { phase: assistantPhase } : {}),
      });

      if (assistantPhase === "commentary") {
        lastProgressAt = Date.now();
        return;
      }

      if (stallNotified) {
        stallNotified = false;
        recordTaskRunProgressByRunId({
          runId,
          runtime: "acp",
          sessionKey: params.childSessionKey,
          lastEventAt: Date.now(),
          eventSummary: "Resumed output.",
        });
        // Resumed notice is a running-phase progress signal.
        emit(
          `${relayLabel} resumed output.`,
          `${contextPrefix}:resumed`,
          classifyRelayStreamEmission({ stream: "lifecycle", lifecyclePhase: "resumed" }),
        );
      }

      lastProgressAt = Date.now();
      pendingText += delta;
      // Promote the pending-phase to final_answer if ANY delta in the buffer
      // is a final_answer frame; otherwise leave it as commentary/undefined.
      // This matches upstream behavior where codex_app_server emits a final
      // agentMessage that carries the terminal reply.
      if (assistantPhase === "final_answer") {
        pendingAssistantPhase = "final_answer";
      } else if (!pendingAssistantPhase && assistantPhase) {
        pendingAssistantPhase = assistantPhase;
      }
      // G5a: track whether ANY delta in this stream has carried an explicit
      // phase. Used by scheduleFlush to defer timer-initiated flushes for
      // phase-less (Claude-style) streams so lifecycle-end can promote them.
      if (assistantPhase) {
        observedExplicitPhase = true;
      }
      if (pendingText.length > STREAM_BUFFER_MAX_CHARS) {
        pendingText = pendingText.slice(-STREAM_BUFFER_MAX_CHARS);
      }
      // Invariant: for phase-less streams (Claude-style), size-triggered
      // flushes are deferred to scheduleFlush so the terminal lifecycle-end
      // can promote the buffer to final_reply. Paragraph-boundary flushes
      // still fire for phased (Codex-style) streams to surface mid-stream
      // progress summaries.
      const sizeTriggered = pendingText.length >= STREAM_SNIPPET_MAX_CHARS;
      const boundaryTriggered = delta.includes("\n\n");
      if (sizeTriggered && !observedExplicitPhase) {
        scheduleFlush();
        return;
      }
      if (sizeTriggered || boundaryTriggered) {
        flushPending();
        return;
      }
      scheduleFlush();
      return;
    }

    if (event.stream !== "lifecycle") {
      return;
    }

    const phase = normalizeOptionalString((event.data as { phase?: unknown } | undefined)?.phase);
    logEvent("lifecycle", { phase: phase ?? "unknown", data: event.data });
    if (phase === "end") {
      // F4: flush remaining buffered text as `final_reply` when the child
      // terminates cleanly. Lifecycle-end is the authoritative terminal
      // boundary for Claude ACP deltas that omit the assistant `phase`.
      flushPending({ terminal: true });
      const startedAt = toFiniteNumber(
        (event.data as { startedAt?: unknown } | undefined)?.startedAt,
      );
      const endedAt = toFiniteNumber((event.data as { endedAt?: unknown } | undefined)?.endedAt);
      const durationMs =
        startedAt != null && endedAt != null && endedAt >= startedAt
          ? endedAt - startedAt
          : undefined;
      const completionClass = classifyRelayStreamEmission({
        stream: "lifecycle",
        lifecyclePhase: "end",
      });
      if (durationMs != null) {
        emit(
          `${relayLabel} run completed in ${Math.max(1, Math.round(durationMs / 1000))}s.`,
          `${contextPrefix}:done`,
          completionClass,
        );
      } else {
        emit(`${relayLabel} run completed.`, `${contextPrefix}:done`, completionClass);
      }
      dispose();
      return;
    }

    if (phase === "error") {
      // SHOULD-FIX #4: promote buffered assistant text to final_reply even on
      // error-terminated streams. Phase-less (Claude-style) streams that die
      // without a clean lifecycle-end would otherwise ship their pending
      // buffer as `progress` (or drop it silently), losing the last visible
      // words the user needs to interpret the failure.
      flushPending({ terminal: true });
      const errorText = normalizeOptionalString(
        (event.data as { error?: unknown } | undefined)?.error,
      );
      const errorClass = classifyRelayStreamEmission({
        stream: "lifecycle",
        lifecyclePhase: "error",
      });
      if (errorText) {
        emit(`${relayLabel} run failed: ${errorText}`, `${contextPrefix}:error`, errorClass);
      } else {
        emit(`${relayLabel} run failed.`, `${contextPrefix}:error`, errorClass);
      }
      dispose();
    }
  });

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearFlushTimer();
    clearRelayLifetimeTimer();
    flushLogBuffer();
    clearInterval(noOutputWatcherTimer);
    unsubscribe();
  };

  return {
    dispose,
    notifyStarted: emitStartNotice,
  };
}

export type AcpSpawnParentRelayHandle = {
  dispose: () => void;
  notifyStarted: () => void;
};
