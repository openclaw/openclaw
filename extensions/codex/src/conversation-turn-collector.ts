// Codex plugin module implements conversation turn collector behavior.
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readCodexNotificationThreadId,
  readCodexNotificationTurnId,
} from "./app-server/notification-correlation.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
} from "./app-server/protocol.js";

const MAX_PENDING_NOTIFICATIONS_PER_TURN = 100;

export function createCodexConversationTurnCollector(threadId: string) {
  let turnId: string | undefined;
  let completed = false;
  let failedError: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const assistantTextByItem = new Map<string, string>();
  const assistantOrder: string[] = [];
  const pendingNotificationsByTurnId = new Map<string, CodexServerNotification[]>();
  let resolveCompletion: ((value: { replyText: string }) => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;

  const rememberItem = (itemId: string) => {
    if (!assistantOrder.includes(itemId)) {
      assistantOrder.push(itemId);
    }
  };
  const collectReplyText = (): string => {
    const texts = assistantOrder
      .map((itemId) => assistantTextByItem.get(itemId)?.trim())
      .filter((text): text is string => Boolean(text));
    return texts.at(-1) ?? "";
  };
  const clearWaitState = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    resolveCompletion = undefined;
    rejectCompletion = undefined;
  };
  // Codex marks a turn "failed" whenever any turn-affecting error fired during it
  // (sandbox/stream/usage errors) and never clears that flag on recovery — see
  // ../codex app-server bespoke_event_handling.rs (handle_turn_complete derives
  // status from the sticky turn_summary.last_error). So a recovered turn can
  // complete failed while still carrying a final assistant message. Surface that
  // recovered answer instead of leaking the stale internal failure as a Slack
  // banner; only reject when no answer was produced (a true unrecovered failure).
  const terminalOutcome = (): { ok: true; replyText: string } | { ok: false; error: string } => {
    const replyText = collectReplyText();
    if (failedError && !replyText) {
      return { ok: false, error: failedError };
    }
    return { ok: true, replyText };
  };
  const finish = () => {
    if (completed) {
      return;
    }
    completed = true;
    const outcome = terminalOutcome();
    if (outcome.ok) {
      resolveCompletion?.({ replyText: outcome.replyText });
    } else {
      rejectCompletion?.(new Error(outcome.error));
    }
    clearWaitState();
  };

  const handleNotification = (notification: CodexServerNotification) => {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params || readCodexNotificationThreadId(params) !== threadId) {
      return;
    }
    if (!turnId) {
      const pendingTurnId = readNotificationTurnId(params);
      if (pendingTurnId) {
        const pending = pendingNotificationsByTurnId.get(pendingTurnId) ?? [];
        if (pending.length < MAX_PENDING_NOTIFICATIONS_PER_TURN) {
          pending.push(notification);
          pendingNotificationsByTurnId.set(pendingTurnId, pending);
        }
      }
      return;
    }
    if (!isNotificationForTurn(params, threadId, turnId)) {
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const itemId = readString(params, "itemId") ?? "assistant";
      const delta = readTextString(params, "delta");
      if (!delta) {
        return;
      }
      rememberItem(itemId);
      assistantTextByItem.set(itemId, `${assistantTextByItem.get(itemId) ?? ""}${delta}`);
      return;
    }
    if (notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      if (item?.type === "agentMessage") {
        const itemId = readString(item, "id") ?? readString(params, "itemId") ?? "assistant";
        const text = readTextString(item, "text");
        if (text) {
          rememberItem(itemId);
          assistantTextByItem.set(itemId, text);
        }
      }
      return;
    }
    if (notification.method === "turn/completed") {
      const turn = isJsonObject(params.turn) ? params.turn : undefined;
      const status = readString(turn, "status");
      if (status === "failed") {
        failedError =
          readString(readRecord(turn?.error), "message") ?? "codex app-server turn failed";
      }
      const items = Array.isArray(turn?.items) ? turn.items : [];
      for (const item of items) {
        if (!isJsonObject(item) || item.type !== "agentMessage") {
          continue;
        }
        const itemId = readString(item, "id") ?? `assistant-${assistantOrder.length + 1}`;
        const text = readTextString(item, "text");
        if (text) {
          rememberItem(itemId);
          assistantTextByItem.set(itemId, text);
        }
      }
      finish();
    }
  };

  return {
    setTurnId(nextTurnId: string) {
      turnId = nextTurnId;
      const pending = pendingNotificationsByTurnId.get(nextTurnId) ?? [];
      pendingNotificationsByTurnId.clear();
      for (const notification of pending) {
        handleNotification(notification);
      }
    },
    handleNotification,
    wait(params: { timeoutMs: number }): Promise<{ replyText: string }> {
      if (completed) {
        const outcome = terminalOutcome();
        return outcome.ok
          ? Promise.resolve({ replyText: outcome.replyText })
          : Promise.reject(new Error(outcome.error));
      }
      return new Promise<{ replyText: string }>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
        timeout = setTimeout(
          () => {
            completed = true;
            reject(new Error("codex app-server bound turn timed out"));
            clearWaitState();
          },
          resolveTimerTimeoutMs(params.timeoutMs, 100, 100),
        );
        timeout.unref?.();
      });
    },
  };
}

function isNotificationForTurn(
  params: JsonObject,
  threadId: string,
  turnId: string | undefined,
): boolean {
  if (readCodexNotificationThreadId(params) !== threadId) {
    return false;
  }
  if (!turnId) {
    return true;
  }
  const directTurnId = readString(params, "turnId");
  if (directTurnId) {
    return directTurnId === turnId;
  }
  const turn = isJsonObject(params.turn) ? params.turn : undefined;
  return readString(turn, "id") === turnId;
}

function readNotificationTurnId(params: JsonObject): string | undefined {
  return readCodexNotificationTurnId(params);
}

function readString(record: Record<string, unknown> | JsonObject | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readTextString(record: Record<string, unknown> | JsonObject | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
