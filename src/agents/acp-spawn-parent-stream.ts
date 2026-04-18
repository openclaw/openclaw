import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { recordReceipt } from "../infra/outbound/delivery-receipts.js";
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
// webhook identity path functional for long assistant replies. Reserved
// headroom (~100 chars) accommodates mention rewriting and a small
// continuation indicator without hitting the wall.
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

// Split a long final_reply body into chunks that fit under Discord's 2000-char
// message limit. Prefers paragraph boundaries ("\n\n"), then line boundaries,
// then word boundaries, and finally a hard slice when a single word exceeds the
// chunk budget. Returns the input unchanged when it already fits. Chunks are
// trimmed of trailing whitespace but internal newlines are preserved so the
// assistant's formatting survives across splits.
export function splitLongFinalReply(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const body = text ?? "";
  if (!body) {
    return [];
  }
  if (body.length <= limit) {
    return [body];
  }
  const chunks: string[] = [];
  let remaining = body;
  while (remaining.length > limit) {
    // Prefer a paragraph break ("\n\n") within the budget; fall back to the
    // last newline, then the last whitespace, then a hard slice.
    const window = remaining.slice(0, limit);
    let splitAt = window.lastIndexOf("\n\n");
    if (splitAt <= 0) {
      splitAt = window.lastIndexOf("\n");
    }
    if (splitAt <= 0) {
      // Last whitespace before the limit so we don't tear words apart.
      const wsMatch = window.match(/\s[^\s]*$/);
      if (wsMatch && typeof wsMatch.index === "number" && wsMatch.index > 0) {
        splitAt = wsMatch.index;
      }
    }
    if (splitAt <= 0) {
      splitAt = limit;
    }
    const head = remaining.slice(0, splitAt).replace(/\s+$/, "");
    if (head) {
      chunks.push(head);
    }
    remaining = remaining.slice(splitAt).replace(/^\s+/, "");
  }
  if (remaining) {
    chunks.push(remaining);
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
  const directPostFinalReply = (
    text: string,
    contextKey: string,
    messageClass: MessageClass,
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
    const threadIdForPost = ctx.threadId;
    // Discord hard-rejects single webhook messages > 2000 chars. The webhook
    // path in the discord plugin does NOT pre-chunk, so long assistant replies
    // would silently fail here. Split across sequential sends, preserving
    // paragraph/line boundaries where possible. Short replies take the
    // single-send fast path below.
    const chunks = splitLongFinalReply(text, DIRECT_POST_CHUNK_MAX_CHARS);
    const threadOption =
      typeof threadIdForPost === "number"
        ? { threadId: threadIdForPost }
        : typeof threadIdForPost === "string" && threadIdForPost
          ? { threadId: threadIdForPost }
          : {};
    const dispatch = async () => {
      for (const chunk of chunks) {
        if (!chunk) {
          continue;
        }
        await sendMessage({
          channel: surface.channel,
          to: surface.to,
          content: chunk,
          accountId: surface.accountId,
          ...threadOption,
          bestEffort: true,
        });
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
    if (directPostFinalReply(payload, contextKey, messageClass)) {
      recordReceipt(parentSessionKey, {
        target,
        messageClass,
        outcome: "delivered",
        reason: "direct_post_final_reply",
        ts: Date.now(),
        resolvedContextAt,
      });
      wake();
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
    // Production bug fix: final_reply content reaches the bound Discord thread
    // verbatim via directPostFinalReply (and, when no thread is bound, is
    // spliced into the parent's next turn). Previously we squashed EVERY
    // assistant flush to a 220-char snippet and prefixed it with the relay
    // label, which meant long-form Claude/Codex replies never reached the
    // user — only a truncated 220-char preview with a redundant "codex: "
    // prefix (the webhook persona "⚙ codex" already conveys identity). For
    // final_reply we now preserve the full buffered text (trimmed, newlines
    // intact) and skip the relay-label prefix; directPostFinalReply handles
    // Discord's 2000-char hard limit by splitting across sequential posts.
    // progress-class flushes keep the snippet+label format so parent session-
    // queue summaries stay compact.
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
      // Production bug fix: for phase-less streams (Claude ACP deltas omit
      // `phase`) the SIZE-based immediate flush would split the full assistant
      // reply into truncated 220-char `progress` snippets, leaving lifecycle-
      // end with nothing to promote to `final_reply`. Defer size-triggered
      // flushes until an explicit phase is observed or the buffer truly
      // overflows STREAM_BUFFER_MAX_CHARS (already tail-sliced above). The
      // `"\n\n"` boundary-triggered flush is retained so operators can still
      // receive mid-stream progress summaries from Codex-style (phased)
      // streams; the timer-flush deferral in `scheduleFlush` covers the time
      // axis symmetrically for phase-less streams.
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
      flushPending();
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
