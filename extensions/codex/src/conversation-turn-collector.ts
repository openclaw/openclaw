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
const MAX_PROGRESS_TEXT_CHARS = 1_200;
const MIN_PROGRESS_INTERVAL_MS = 1_500;

export function createCodexConversationTurnCollector(
  threadId: string,
  options: {
    onProgress?: (text: string) => void | Promise<void>;
  } = {},
) {
  let turnId: string | undefined;
  let completed = false;
  let failedError: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let waitTimeoutMs = 0;
  let timeoutSuspended = 0;
  const assistantTextByItem = new Map<string, string>();
  const planTextByItem = new Map<string, string>();
  const itemPhaseById = new Map<string, string>();
  const assistantOrder: string[] = [];
  const planOrder: string[] = [];
  const pendingNotificationsByTurnId = new Map<string, CodexServerNotification[]>();
  const lastProgressTextByKey = new Map<string, string>();
  const lastProgressAtByKey = new Map<string, number>();
  let resolveCompletion: ((value: { replyText: string; planText: string }) => void) | undefined;
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
  const rememberPlanItem = (itemId: string) => {
    if (!planOrder.includes(itemId)) {
      planOrder.push(itemId);
    }
  };
  const collectPlanText = (): string => {
    return planOrder
      .map((itemId) => planTextByItem.get(itemId)?.trim())
      .filter((text): text is string => Boolean(text))
      .join("\n\n");
  };
  const clearWaitState = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    waitTimeoutMs = 0;
    timeoutSuspended = 0;
    resolveCompletion = undefined;
    rejectCompletion = undefined;
  };
  const scheduleTimeout = () => {
    if (!rejectCompletion || completed || timeoutSuspended > 0) {
      return;
    }
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      completed = true;
      rejectCompletion?.(new Error("codex app-server bound turn timed out"));
      clearWaitState();
    }, waitTimeoutMs);
    timeout.unref?.();
  };
  const resetTimeout = () => {
    if (!rejectCompletion || !waitTimeoutMs || completed || timeoutSuspended > 0) {
      return;
    }
    scheduleTimeout();
  };
  const finish = () => {
    if (completed) {
      return;
    }
    completed = true;
    if (failedError) {
      rejectCompletion?.(new Error(failedError));
    } else {
      resolveCompletion?.({ replyText: collectReplyText(), planText: collectPlanText() });
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
    resetTimeout();
    if (notification.method === "item/agentMessage/delta") {
      const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "assistant";
      const delta = readTextString(params, "delta");
      if (!delta) {
        return;
      }
      rememberItem(itemId);
      assistantTextByItem.set(itemId, `${assistantTextByItem.get(itemId) ?? ""}${delta}`);
      if (itemPhaseById.get(itemId) === "commentary") {
        emitProgress(`Codex: ${assistantTextByItem.get(itemId) ?? ""}`, `assistant:${itemId}`);
      }
      return;
    }
    if (notification.method === "item/plan/delta") {
      const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "plan";
      const delta = readTextString(params, "delta");
      if (!delta) {
        return;
      }
      rememberPlanItem(itemId);
      planTextByItem.set(itemId, `${planTextByItem.get(itemId) ?? ""}${delta}`);
      emitProgress(`Codex plan:\n${planTextByItem.get(itemId) ?? ""}`, `plan:${itemId}`);
      return;
    }
    if (notification.method === "turn/plan/updated") {
      const text = formatTurnPlanUpdated(params);
      if (text) {
        emitProgress(text, "turn-plan");
      }
      return;
    }
    if (notification.method === "item/started") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      const itemId = item ? (readString(item, "id") ?? readString(params, "itemId")) : undefined;
      const itemType = item ? readString(item, "type") : undefined;
      if (item && itemId && itemType) {
        const phase = readString(item, "phase");
        if (phase) {
          itemPhaseById.set(itemId, phase);
        }
        const label = formatItemLabel(item);
        if (label) {
          emitProgress(`Codex started ${label}.`, `start:${itemId}`, { force: true });
        }
      }
      return;
    }
    if (notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      const itemId = readString(item, "id") ?? readString(params, "itemId");
      if (item?.type === "agentMessage") {
        const messageItemId = itemId ?? "assistant";
        const text = readTextString(item, "text");
        if (text) {
          rememberItem(messageItemId);
          assistantTextByItem.set(messageItemId, text);
        }
      } else if (item?.type === "plan") {
        const planItemId = itemId ?? "plan";
        const text = readTextString(item, "text");
        if (text) {
          rememberPlanItem(planItemId);
          planTextByItem.set(planItemId, text);
        }
      }
      const label = item ? formatItemLabel(item) : undefined;
      if (item && itemId && label && item.type !== "agentMessage" && item.type !== "plan") {
        emitProgress(`Codex completed ${label}.`, `done:${itemId}`, { force: true });
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
        if (!isJsonObject(item)) {
          continue;
        }
        if (item.type === "agentMessage") {
          const itemId = readString(item, "id") ?? `assistant-${assistantOrder.length + 1}`;
          const text = readTextString(item, "text");
          if (text) {
            rememberItem(itemId);
            assistantTextByItem.set(itemId, text);
          }
        } else if (item.type === "plan") {
          const itemId = readString(item, "id") ?? `plan-${planOrder.length + 1}`;
          const text = readTextString(item, "text");
          if (text) {
            rememberPlanItem(itemId);
            planTextByItem.set(itemId, text);
          }
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
    wait(params: { timeoutMs: number }): Promise<{ replyText: string; planText: string }> {
      if (completed) {
        return failedError
          ? Promise.reject(new Error(failedError))
          : Promise.resolve({ replyText: collectReplyText(), planText: collectPlanText() });
      }
      return new Promise<{ replyText: string; planText: string }>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
        waitTimeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 100, 100);
        scheduleTimeout();
      });
    },
    suspendTimeout(): () => void {
      if (completed) {
        return () => undefined;
      }
      timeoutSuspended += 1;
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      let resumed = false;
      return () => {
        if (resumed) {
          return;
        }
        resumed = true;
        timeoutSuspended = Math.max(0, timeoutSuspended - 1);
        scheduleTimeout();
      };
    },
  };

  function emitProgress(text: string, key: string, opts?: { force?: boolean }) {
    const trimmed = truncateText(text.trim());
    if (!trimmed) {
      return;
    }
    if (!opts?.force && lastProgressTextByKey.get(key) === trimmed) {
      return;
    }
    const now = Date.now();
    if (!opts?.force && now - (lastProgressAtByKey.get(key) ?? 0) < MIN_PROGRESS_INTERVAL_MS) {
      lastProgressTextByKey.set(key, trimmed);
      return;
    }
    lastProgressTextByKey.set(key, trimmed);
    lastProgressAtByKey.set(key, now);
    void options.onProgress?.(trimmed);
  }
}

function formatTurnPlanUpdated(params: JsonObject): string | undefined {
  const plan = Array.isArray(params.plan) ? params.plan : [];
  const steps = plan
    .map((entry) => {
      const record = readRecord(entry);
      const step = record ? readTextString(record, "step") : undefined;
      const status = record ? readString(record, "status") : undefined;
      return step ? `- ${step}${status ? ` (${status})` : ""}` : undefined;
    })
    .filter((line): line is string => Boolean(line));
  if (steps.length === 0) {
    return undefined;
  }
  const explanation = readTextString(params, "explanation");
  return ["Codex plan updated:", ...(explanation ? [explanation] : []), ...steps].join("\n");
}

function formatItemLabel(item: JsonObject): string | undefined {
  const type = readString(item, "type");
  if (!type) {
    return undefined;
  }
  const tool = readString(item, "tool") ?? readString(item, "name");
  const command = readString(item, "command");
  if (tool) {
    return `${tool} (${type})`;
  }
  if (command) {
    return `${command} (${type})`;
  }
  if (type === "agentMessage" || type === "plan") {
    return undefined;
  }
  return type;
}

function truncateText(text: string): string {
  return text.length > MAX_PROGRESS_TEXT_CHARS
    ? `${text.slice(0, MAX_PROGRESS_TEXT_CHARS - 1)}…`
    : text;
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
