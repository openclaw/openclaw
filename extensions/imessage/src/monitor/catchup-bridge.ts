import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import type { IMessageRpcClient } from "../client.js";
import {
  type CatchupDispatchFn,
  type CatchupFetchFn,
  type IMessageCatchupRow,
  type IMessageCatchupSummary,
  performIMessageCatchup,
  type ResolvedCatchupConfig,
} from "./catchup.js";
import { parseIMessageNotification } from "./parse-notification.js";
import type { IMessagePayload } from "./types.js";

// imsg returns newest-first: fetch the full page before choosing the global oldest rows.
const PER_CHAT_HISTORY_LIMIT = 500;

const CATCHUP_CHATS_LIST_LIMIT = 200;

const CATCHUP_RPC_TIMEOUT_MS = 30_000;

type ChatsListEntry = {
  id?: number | null;
  last_message_at?: string | null;
};

type MessagesHistoryResult = {
  messages?: unknown[];
};

type RuntimeLogger = {
  log?: (msg: string) => void;
  error?: (msg: string) => void;
};

type RunIMessageCatchupParams = {
  client: IMessageRpcClient;
  accountId: string;
  config: ResolvedCatchupConfig;
  includeAttachments: boolean;
  /**
   * The durable admission handler shared with live `imsg watch` notifications.
   * Catchup feeds rows oldest-first by rowid. Throws are recorded as admission
   * failures; non-throw returns mean the row is durably queued.
   */
  dispatchPayload: (message: IMessagePayload, rawEnvelope: unknown) => Promise<void>;
  /**
   * Called for `is_from_me=true` rows that catchup intentionally does not
   * dispatch. The live inbound path still needs to observe those rows so
   * self-chat reflected companion rows can be deduped.
   */
  observeSkippedFromMePayload?: (message: IMessagePayload) => Promise<void> | void;
  runtime?: RuntimeLogger;
  /** Override clock for tests. */
  now?: () => number;
};

/** Replay oldest-first through durable admission; tombstones reject live/watch overlap. */
export async function runIMessageCatchup(
  params: RunIMessageCatchupParams,
): Promise<IMessageCatchupSummary> {
  const { client, accountId, config, includeAttachments, dispatchPayload, runtime } = params;
  const log = (msg: string) => runtime?.log?.(msg);
  const warnLog = (msg: string) => runtime?.log?.(warn(msg));

  const payloadByGuid = new Map<
    string,
    { message: IMessagePayload; rawEnvelope: { message: unknown } }
  >();

  const fetchFn: CatchupFetchFn = async ({ sinceMs, sinceRowid, limit }) => {
    const sinceISO = timestampMsToIsoString(sinceMs);
    if (!sinceISO) {
      warnLog(`imessage catchup: invalid since timestamp ${sinceMs}`);
      return { resolved: false, rows: [] };
    }
    let chatsResult: { chats?: ChatsListEntry[] } | undefined;
    try {
      chatsResult = await client.request<{ chats?: ChatsListEntry[] }>(
        "chats.list",
        { limit: CATCHUP_CHATS_LIST_LIMIT },
        { timeoutMs: CATCHUP_RPC_TIMEOUT_MS },
      );
    } catch (err) {
      warnLog(`imessage catchup: chats.list failed: ${String(err)}`);
      return { resolved: false, rows: [] };
    }
    const chats = chatsResult?.chats ?? [];
    const collected: IMessageCatchupRow[] = [];
    let historyFetchFailed = false;
    // Include parse-rejected rows so corrupt history cannot stall the next startup.
    let rawWatermarkRowid = -Infinity;
    let rawWatermarkMs = -Infinity;

    for (const chat of chats) {
      const chatId = typeof chat.id === "number" && Number.isFinite(chat.id) ? chat.id : null;
      if (chatId === null) {
        continue;
      }
      const lastMs =
        typeof chat.last_message_at === "string" ? Date.parse(chat.last_message_at) : Number.NaN;
      if (Number.isFinite(lastMs) && lastMs < sinceMs) {
        continue;
      }

      let historyResult: MessagesHistoryResult | undefined;
      try {
        historyResult = await client.request<MessagesHistoryResult>(
          "messages.history",
          {
            chat_id: chatId,
            limit: PER_CHAT_HISTORY_LIMIT,
            start: sinceISO,
            attachments: includeAttachments,
          },
          { timeoutMs: CATCHUP_RPC_TIMEOUT_MS },
        );
      } catch (err) {
        historyFetchFailed = true;
        warnLog(`imessage catchup: messages.history failed for chat_id=${chatId}: ${String(err)}`);
        continue;
      }

      const messages = Array.isArray(historyResult?.messages) ? historyResult.messages : [];
      for (const raw of messages) {
        const rawRecord = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
        const rawRowid =
          rawRecord && typeof rawRecord.id === "number" && Number.isFinite(rawRecord.id)
            ? rawRecord.id
            : null;
        const rawCreatedAt =
          rawRecord && typeof rawRecord.created_at === "string" ? rawRecord.created_at : null;
        const rawDateMs = rawCreatedAt ? Date.parse(rawCreatedAt) : Number.NaN;
        if (rawRowid !== null) {
          rawWatermarkRowid = Math.max(rawWatermarkRowid, rawRowid);
        }
        if (Number.isFinite(rawDateMs)) {
          rawWatermarkMs = Math.max(rawWatermarkMs, rawDateMs);
        }

        const payload = parseIMessageNotification({ message: raw });
        if (!payload) {
          continue;
        }
        const guid = payload.guid?.trim();
        const rowid = typeof payload.id === "number" ? payload.id : null;
        const dateMs =
          typeof payload.created_at === "string" ? Date.parse(payload.created_at) : Number.NaN;
        if (!guid || rowid === null || !Number.isFinite(rowid) || !Number.isFinite(dateMs)) {
          continue;
        }
        if (rowid <= sinceRowid) {
          continue;
        }
        collected.push({
          guid,
          rowid,
          date: dateMs,
          isFromMe: payload.is_from_me === true,
        });
        payloadByGuid.set(guid, { message: payload, rawEnvelope: { message: raw } });
      }
    }

    const sorted = collected.toSorted((a, b) => a.rowid - b.rowid);
    const capped = sorted.slice(0, limit);
    const isCapTruncated = capped.length < sorted.length;
    if (isCapTruncated) {
      warnLog(
        `imessage catchup: fetched ${sorted.length} rows across chats, ` +
          `capped to perRunLimit=${limit} (oldest first); next startup picks up the rest`,
      );
    }

    // Never advance past valid rows excluded by perRunLimit.
    let effectiveWatermarkRowid = rawWatermarkRowid;
    let effectiveWatermarkMs = rawWatermarkMs;
    if (isCapTruncated) {
      const last = capped.at(-1);
      // A zero cap produces NaN watermarks and preserves the prior cursor.
      effectiveWatermarkRowid = last ? Math.min(rawWatermarkRowid, last.rowid) : Number.NaN;
      effectiveWatermarkMs = last ? Math.min(rawWatermarkMs, last.date) : Number.NaN;
    }

    return {
      resolved: true,
      rows: capped,
      fullyCaughtUp: !historyFetchFailed && !isCapTruncated,
      ...(Number.isFinite(effectiveWatermarkRowid)
        ? { highWatermarkRowid: effectiveWatermarkRowid }
        : {}),
      ...(Number.isFinite(effectiveWatermarkMs) ? { highWatermarkMs: effectiveWatermarkMs } : {}),
    };
  };

  const dispatchFn: CatchupDispatchFn = async (row) => {
    const entry = payloadByGuid.get(row.guid);
    if (!entry) {
      warnLog(`imessage catchup: missing payload for guid=${row.guid}, skipping`);
      return { ok: false };
    }
    await dispatchPayload(entry.message, entry.rawEnvelope);
    return { ok: true };
  };

  return await performIMessageCatchup({
    accountId,
    config,
    fetch: fetchFn,
    dispatch: dispatchFn,
    observeSkippedFromMe: async (row) => {
      const entry = payloadByGuid.get(row.guid);
      if (!entry) {
        warnLog(`imessage catchup: missing skipped from-me payload for guid=${row.guid}`);
        return;
      }
      await params.observeSkippedFromMePayload?.(entry.message);
    },
    log,
    warn: warnLog,
    ...(params.now ? { now: params.now() } : {}),
  });
}
