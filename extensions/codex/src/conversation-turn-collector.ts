/** Collects terminal assistant text for bounded Codex app-server turns. */
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isCodexNotificationForTurn,
  readCodexNotificationThreadId,
} from "./app-server/notification-correlation.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
} from "./app-server/protocol.js";

export type CodexTerminalTextCollectorFailure =
  | { kind: "turn-failed"; turn: JsonObject }
  | { kind: "turn-interrupted"; turn: JsonObject }
  | { kind: "notification"; params: JsonObject }
  | { kind: "aborted"; signal?: AbortSignal }
  | { kind: "timeout" };

export type CodexTerminalTextCollectorOptions = {
  taskLabel?: string;
  combineAssistantMessages?: boolean;
  onAssistantMessageStart?: () => Promise<void> | void;
  formatError?: (failure: CodexTerminalTextCollectorFailure) => Error | string | undefined;
};

type AssistantMessage = {
  text: string;
  phase?: string;
};

/** Creates one terminal-text collector; thread routing owns pre-bind buffering. */
export function createCodexTerminalTextCollector(
  threadId: string,
  options: CodexTerminalTextCollectorOptions = {},
) {
  const taskLabel = options.taskLabel?.trim() || "bound";
  let turnId: string | undefined;
  let settled = false;
  let terminalTurnCompleted = false;
  let terminalError: Error | undefined;
  let replyText = "";
  let assistantStarted = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let waitSignal: AbortSignal | undefined;
  let abortWait: (() => void) | undefined;
  const assistantMessages = new Map<string, AssistantMessage>();
  let resolveCompletion: ((value: { replyText: string }) => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;

  const rememberAssistantMessage = (itemId: string, message: Partial<AssistantMessage>) => {
    // Deltas identify the item but current Codex versions put the authoritative
    // commentary/final phase on item/completed.
    const current = assistantMessages.get(itemId);
    const phase = normalizeMessagePhase(message.phase ?? current?.phase);
    assistantMessages.set(itemId, {
      text: message.text ?? current?.text ?? "",
      ...(phase ? { phase } : {}),
    });
  };
  const collectReplyText = (): string => {
    const messages = [...assistantMessages.values()].filter((message) => message.text.trim());
    const finalMessages = messages.filter((message) => message.phase === "final_answer");
    const nonCommentaryMessages = messages.filter((message) => message.phase !== "commentary");
    if (options.combineAssistantMessages) {
      const preferred = nonCommentaryMessages.length > 0 ? nonCommentaryMessages : messages;
      return preferred.map((message) => message.text.trim()).join("\n\n");
    }
    return (
      finalMessages.at(-1)?.text.trim() ??
      nonCommentaryMessages.at(-1)?.text.trim() ??
      messages.at(-1)?.text.trim() ??
      ""
    );
  };
  const clearWaitState = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    if (waitSignal && abortWait) {
      waitSignal.removeEventListener("abort", abortWait);
    }
    waitSignal = undefined;
    abortWait = undefined;
    resolveCompletion = undefined;
    rejectCompletion = undefined;
  };
  const resolveSuccess = () => {
    if (settled) {
      return;
    }
    settled = true;
    replyText = collectReplyText();
    resolveCompletion?.({ replyText });
    clearWaitState();
  };
  const rejectFailure = (failure: CodexTerminalTextCollectorFailure) => {
    if (settled) {
      return;
    }
    settled = true;
    terminalError = formatCollectorError(failure, options, taskLabel);
    rejectCompletion?.(terminalError);
    clearWaitState();
  };

  const handleTerminalTurn = (value: unknown) => {
    if (!isJsonObject(value)) {
      return;
    }
    const status = readString(value, "status");
    if (!isTerminalTurnStatus(status)) {
      return;
    }
    terminalTurnCompleted = true;
    const items = Array.isArray(value.items) ? value.items : [];
    const terminalMessages = items.flatMap((item, index) => {
      if (!isJsonObject(item) || item.type !== "agentMessage") {
        return [];
      }
      const phase = readString(item, "phase");
      return [
        {
          id: readString(item, "id") ?? `assistant-${index + 1}`,
          text: readTextString(item, "text") ?? "",
          ...(phase ? { phase } : {}),
        },
      ];
    });
    if (terminalMessages.length > 0) {
      // The terminal snapshot is authoritative and avoids combining streamed
      // deltas with a differently keyed copy of the same final message.
      assistantMessages.clear();
    }
    for (const message of terminalMessages) {
      rememberAssistantMessage(message.id, message);
    }
    if (status === "failed") {
      rejectFailure({ kind: "turn-failed", turn: value });
      return;
    }
    if (status === "interrupted") {
      rejectFailure({ kind: "turn-interrupted", turn: value });
      return;
    }
    resolveSuccess();
  };

  const handleNotification = async (notification: CodexServerNotification): Promise<void> => {
    if (settled) {
      return;
    }
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params || readCodexNotificationThreadId(params) !== threadId) {
      return;
    }
    if (!turnId) {
      return;
    }
    if (!isCodexNotificationForTurn(params, threadId, turnId)) {
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "assistant";
      const delta = readTextString(params, "delta");
      if (!delta) {
        return;
      }
      if (!assistantStarted) {
        assistantStarted = true;
        if (options.onAssistantMessageStart) {
          await options.onAssistantMessageStart();
        }
      }
      if (settled) {
        return;
      }
      const current = assistantMessages.get(itemId);
      const phase = readString(params, "phase");
      rememberAssistantMessage(itemId, {
        text: `${current?.text ?? ""}${delta}`,
        ...(phase ? { phase } : {}),
      });
      return;
    }
    if (notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      if (item?.type === "agentMessage") {
        const itemId = readString(item, "id") ?? readString(params, "itemId") ?? "assistant";
        const text = readTextString(item, "text");
        const phase = readString(item, "phase");
        rememberAssistantMessage(itemId, {
          ...(text !== undefined ? { text } : {}),
          ...(phase ? { phase } : {}),
        });
      }
      return;
    }
    if (notification.method === "turn/completed") {
      const turn = isJsonObject(params.turn) ? params.turn : undefined;
      handleTerminalTurn(turn);
      return;
    }
    if (notification.method === "error") {
      if (params.willRetry === true) {
        return;
      }
      rejectFailure({ kind: "notification", params });
    }
  };

  return {
    get completed() {
      // Cleanup may skip interrupt only after Codex itself emitted a terminal turn.
      return terminalTurnCompleted;
    },
    bindTurn(nextTurnId: string, initialTurn?: unknown) {
      turnId = nextTurnId;
      handleTerminalTurn(initialTurn);
    },
    handleNotification,
    wait(params: { timeoutMs: number; signal?: AbortSignal }): Promise<{ replyText: string }> {
      if (settled) {
        return terminalError ? Promise.reject(terminalError) : Promise.resolve({ replyText });
      }
      if (params.signal?.aborted) {
        rejectFailure({ kind: "aborted", signal: params.signal });
        return Promise.reject(terminalError!);
      }
      return new Promise<{ replyText: string }>((resolveWait, rejectWait) => {
        resolveCompletion = resolveWait;
        rejectCompletion = rejectWait;
        waitSignal = params.signal;
        abortWait = () => rejectFailure({ kind: "aborted", signal: params.signal });
        params.signal?.addEventListener("abort", abortWait, { once: true });
        if (params.signal?.aborted) {
          abortWait();
          return;
        }
        timeout = setTimeout(
          () => rejectFailure({ kind: "timeout" }),
          resolveTimerTimeoutMs(params.timeoutMs, 100, 100),
        );
        timeout.unref?.();
      });
    },
  };
}

function formatCollectorError(
  failure: CodexTerminalTextCollectorFailure,
  options: CodexTerminalTextCollectorOptions,
  taskLabel: string,
): Error {
  const formatted = options.formatError?.(failure);
  if (formatted instanceof Error) {
    return formatted;
  }
  if (typeof formatted === "string" && formatted.trim()) {
    return new Error(formatted);
  }
  if (failure.kind === "aborted") {
    return failure.signal?.reason instanceof Error
      ? failure.signal.reason
      : new Error(`codex app-server ${taskLabel} turn aborted`);
  }
  if (failure.kind === "timeout") {
    return new Error(`codex app-server ${taskLabel} turn timed out`);
  }
  if (failure.kind === "turn-interrupted") {
    return new Error(`codex app-server ${taskLabel} turn interrupted`);
  }
  if (failure.kind === "turn-failed") {
    return new Error(
      readString(readRecord(failure.turn.error), "message") ??
        `codex app-server ${taskLabel} turn failed`,
    );
  }
  return new Error(
    readString(readRecord(failure.params.error), "message") ??
      readString(readRecord(failure.params.error), "error") ??
      readString(failure.params, "message") ??
      `codex app-server ${taskLabel} turn failed`,
  );
}

function isTerminalTurnStatus(value: string | undefined): boolean {
  return value === "completed" || value === "interrupted" || value === "failed";
}

function readString(record: Record<string, unknown> | JsonObject | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readTextString(record: Record<string, unknown> | JsonObject | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeMessagePhase(value: string | undefined): string | undefined {
  const phase = value?.trim().toLowerCase();
  return phase || undefined;
}
