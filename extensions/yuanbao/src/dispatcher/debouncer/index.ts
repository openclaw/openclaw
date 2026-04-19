/**
 * Message debounce dispatcher.
 *
 * Centralizes SDK createChannelInboundDebouncer initialization and config.
 * After debounce flush, uses SessionQueue to ensure serial execution per session.
 */

import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { isAbortRequestText, isBtwRequestText } from "openclaw/plugin-sdk/reply-runtime";
import { extractTextFromMsgBody } from "../../business/messaging/extract.js";
import { createPipeline } from "../../business/pipeline/create.js";
import type { PipelineContext, DebouncerItem } from "../../business/pipeline/types.js";
import { createLog } from "../../logger.js";
import type { ModuleLog } from "../../logger.js";
import type { YuanbaoInboundMessage } from "../../types.js";
import { SessionAbortManager } from "../queue/session-abort-manager.js";
import { SessionQueue } from "../queue/session-queue.js";

// ============ Singletons ============

const pipeline = createPipeline();
const sessionQueue = new SessionQueue();
const sessionAbortManager = new SessionAbortManager();

// ============ Debouncer (lazy init) ============

let debouncer: ReturnType<typeof createChannelInboundDebouncer<DebouncerItem>>["debouncer"] | null =
  null;

/** Media message types, used to separate text and media elements from msg_body */
const MEDIA_MSG_TYPES = new Set([
  "TIMImageElem",
  "TIMSoundElem",
  "TIMVideoFileElem",
  "TIMFileElem",
]);

/**
 * Build base sessionKey (without command suffix).
 *
 * Group: `group:{accountId}:{groupCode}`
 * C2C: `direct:{accountId}:{fromAccount}`
 */
function buildBaseSessionKey(item: DebouncerItem): string {
  const { msg, isGroup, account } = item;
  return isGroup
    ? `group:${account.accountId}:${msg.group_code?.trim() || "unknown"}`
    : `direct:${account.accountId}:${msg.from_account?.trim() || "unknown"}`;
}

/**
 * Extract plain text from a DebouncerItem (lightweight, TIMTextElem only).
 */
function extractRawText(item: DebouncerItem): string {
  if (!item.msg.msg_body) {
    return "";
  }
  return item.msg.msg_body
    .filter((elem: { msg_type?: string }) => elem.msg_type === "TIMTextElem")
    .map((elem: { msg_content?: { text?: string } }) => elem.msg_content?.text ?? "")
    .join("")
    .trim();
}

/**
 * Build sessionKey — assigns independent serial queues for different
 * command types in direct chat to prevent control commands from being
 * blocked by regular messages.
 *
 * Direct chat:
 * - abort → `{base}:control`      (stop commands need immediate response)
 * - btw   → `{base}:btw:{seqId}`  (interjections run independently)
 * - normal→ `{base}`              (sequential within the same session)
 *
 * Group chat:
 * - Unified `{base}`, no command-type distinction.
 */
function buildSessionKey(item: DebouncerItem): string {
  const base = buildBaseSessionKey(item);

  // Group chat: no command-type distinction, use a single queue
  if (item.isGroup) {
    return base;
  }

  // Direct chat: assign independent queues by command type
  const rawText = extractRawText(item);

  // abort (/stop etc.) → independent control queue for immediate interruption
  if (isAbortRequestText(rawText)) {
    return `${base}:control`;
  }

  // btw (/btw ...) → each interjection gets its own queue, non-blocking
  if (isBtwRequestText(rawText)) {
    const seqId = item.msg.msg_seq ?? item.msg.msg_id ?? "";
    return seqId ? `${base}:btw:${seqId}` : `${base}:btw`;
  }

  return base;
}

/**
 * Check if this is a normal direct-chat message (not btw, not abort).
 *
 * Only normal direct messages trigger the "new question interrupts old" logic.
 */function isDirectNormalMessage(item: DebouncerItem): boolean {
  if (item.isGroup) {
    return false;
  }
  const rawText = extractRawText(item);
  if (isAbortRequestText(rawText)) {
    return false;
  }
  if (isBtwRequestText(rawText)) {
    return false;
  }
  return true;
}

/**
 * Build minimal context compatible with extractTextFromMsgBody.
 */
function buildMinCtx(item: DebouncerItem, log: ReturnType<typeof createLog>) {
  return {
    account: item.account,
    config: item.config,
    core: item.core,
    log: { ...log, verbose: (...a: [string, Record<string, unknown>?]) => log.debug(...a) },
    wsClient: item.wsClient,
  };
}

/**
 * Merge msg_body from multiple debounced messages into a single synthetic message.
 *
 * Text elements are concatenated in order; media elements are collected in order.
 * Other fields use the primary (last item) as the base.
 */
function buildSyntheticMessage(
  primary: DebouncerItem,
  items: DebouncerItem[],
): YuanbaoInboundMessage {
  const combinedBody = items.flatMap((item) => item.msg.msg_body ?? []);
  return {
    ...primary.msg,
    msg_body: combinedBody,
  };
}

/**
 * Build pipeline context
 */
function buildPipelineContext(primary: DebouncerItem, items: DebouncerItem[]): PipelineContext {
  return {
    // Immutable input
    raw: primary.msg,
    flushedItems: items,
    isGroup: primary.isGroup,
    account: primary.account,
    config: primary.config,
    core: primary.core,
    wsClient: primary.wsClient,
    log: createLog("pipeline", primary.log as ModuleLog | undefined),
    abortSignal: (primary as DebouncerItem & { _sessionAbortSignal?: AbortSignal })
      ._sessionAbortSignal
      ? combineAbortSignals(
          primary.abortSignal,
          (primary as DebouncerItem & { _sessionAbortSignal?: AbortSignal })._sessionAbortSignal,
        )
      : primary.abortSignal,
    statusSink: primary.statusSink,

    // Mutable intermediate state (populated by middleware stages)
    fromAccount: "",
    rawBody: "",
    medias: [],
    isAtBot: false,
    mentions: [],
    linkUrls: [],
    commandAuthorized: false,
    rewrittenBody: "",
    hasControlCommand: false,
    effectiveWasMentioned: false,
    mediaPaths: [],
    mediaTypes: [],
  };
}

/**
 * Combine gateway-level and session-level AbortSignals.
 * The combined signal aborts when either source signal fires.
 */
function combineAbortSignals(
  gatewaySignal?: AbortSignal,
  sessionSignal?: AbortSignal,
): AbortSignal | undefined {
  if (!gatewaySignal && !sessionSignal) {
    return undefined;
  }
  if (!gatewaySignal) {
    return sessionSignal;
  }
  if (!sessionSignal) {
    return gatewaySignal;
  }

  return AbortSignal.any([gatewaySignal, sessionSignal]);
}

/**
 * Clean up session-level AbortSignal attached to a DebouncerItem (prevent memory leaks).
 */
function cleanupSessionSignal(primary: DebouncerItem): void {
  const sessionSignal = (primary as DebouncerItem & { _sessionAbortSignal?: AbortSignal })
    ._sessionAbortSignal;
  if (sessionSignal) {
    const baseKey = buildBaseSessionKey(primary);
    sessionAbortManager.cleanup(baseKey, sessionSignal);
  }
}

/**
 * Ensure the debouncer is initialized and return it
 */
export function ensureDebouncer(config: OpenClawConfig) {
  if (debouncer) {
    return debouncer;
  }

  const debouncerLog = createLog("debouncer");

  const result = createChannelInboundDebouncer<DebouncerItem>({
    cfg: config,
    channel: "yuanbao",

    buildKey: (item) => buildSessionKey(item),

    shouldDebounce: (item) => {
      const minCtx = buildMinCtx(item, debouncerLog);
      const { rawBody } = extractTextFromMsgBody(minCtx, item.msg.msg_body);
      return shouldDebounceTextInbound({
        text: rawBody,
        cfg: item.config,
        hasMedia: Boolean(
          item.msg.msg_body?.some((elem: { msg_type?: string }) =>
            MEDIA_MSG_TYPES.has(elem.msg_type ?? ""),
          ),
        ),
      });
    },

    onFlush: async (items) => {
      const primary = items.at(-1);
      if (!primary) {
        return;
      }

      const sessionKey = buildSessionKey(primary);

      // ⭐ Direct normal message: abort old inference + invalidate queued old tasks
      if (isDirectNormalMessage(primary)) {
        const baseKey = buildBaseSessionKey(primary);
        // Invalidate queued old tasks in base queue (skip execution)
        sessionQueue.invalidate(baseKey);
        // Rotate AbortController: abort old inference, get new signal
        const sessionSignal = sessionAbortManager.rotate(baseKey);
        // Attach session-level signal to primary for buildPipelineContext
        (primary as DebouncerItem & { _sessionAbortSignal?: AbortSignal })._sessionAbortSignal =
          sessionSignal;
      }

      if (items.length === 1) {
        await sessionQueue.enqueue(sessionKey, async () => {
          const pipelineCtx = buildPipelineContext(primary, items);
          try {
            await pipeline.execute(pipelineCtx);
          } finally {
            cleanupSessionSignal(primary);
          }
        });
        return;
      }

      // Merge text + media from multiple messages; skip if empty
      const combinedText = items
        .map((item) => extractRawText(item))
        .filter(Boolean)
        .join("\n");
      const combinedMedia = items.flatMap((item) =>
        (item.msg.msg_body ?? []).filter((elem: { msg_type?: string }) =>
          MEDIA_MSG_TYPES.has(elem.msg_type ?? ""),
        ),
      );
      if (!combinedText.trim() && combinedMedia.length === 0) {
        debouncerLog.info("flush skipped: no text or media after merge", {
          count: items.length,
        });
        return;
      }

      // Build synthetic message: merge msg_body from all items into primary
      const syntheticPrimary: DebouncerItem = {
        ...primary,
        msg: buildSyntheticMessage(primary, items),
      };

      await sessionQueue.enqueue(sessionKey, async () => {
        const pipelineCtx = buildPipelineContext(syntheticPrimary, items);
        try {
          await pipeline.execute(pipelineCtx);
        } finally {
          cleanupSessionSignal(primary);
        }
      });
    },

    // Similar to telegram: onError receives items for richer context logging
    onError: (err, items) => {
      const primary = items.at(-1);
      const sessionKey = primary ? buildSessionKey(primary) : "unknown";
      debouncerLog.error("debouncer flush error", {
        error: String(err),
        sessionKey,
        itemCount: items.length,
      });
    },
  });

  debouncer = result.debouncer;
  return debouncer;
}
