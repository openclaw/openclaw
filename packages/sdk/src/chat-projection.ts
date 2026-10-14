import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonEmptyStringPreservingWhitespace as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { resolveSdkLifecycleEventType } from "./run-terminal.js";
import type { OpenClawEvent } from "./types.js";

type ChatProjectionState = "delta" | "final" | "error" | "aborted";

type ChatProjection = {
  state: ChatProjectionState;
  payload: Record<string, unknown>;
};

export type AssistantProjection = { itemId?: string; text: string };

export function projectAssistantRunEvent(
  event: OpenClawEvent,
  previous: AssistantProjection | undefined,
): { event: OpenClawEvent; assistant: AssistantProjection | undefined } | undefined {
  if (event.raw?.event !== "agent" || asRecord(event.raw.payload).stream !== "assistant") {
    return undefined;
  }
  const data = asRecord(event.data);
  if (typeof data.text !== "string" && typeof data.delta !== "string") {
    return undefined;
  }
  const itemId = typeof data.itemId === "string" ? data.itemId : undefined;
  let text = typeof data.text === "string" ? data.text : undefined;
  if (
    text === undefined &&
    typeof data.delta === "string" &&
    (data.replace === true || (previous && previous.itemId === itemId))
  ) {
    text = (data.replace === true ? "" : (previous?.text ?? "")) + data.delta;
  }
  return {
    event: text === undefined ? event : { ...event, data: { ...data, text } },
    assistant: text === undefined ? undefined : { itemId, text },
  };
}

export function readChatProjection(event: OpenClawEvent): ChatProjection | undefined {
  const raw = event.raw;
  if (event.type !== "raw" || raw?.event !== "chat") {
    return undefined;
  }
  const payload = asRecord(event.data);
  const state = payload.state;
  return state === "delta" || state === "final" || state === "error" || state === "aborted"
    ? { state, payload }
    : undefined;
}

export function readChatProjectionText(payload: Record<string, unknown>): string | undefined {
  const message = asRecord(payload.message);
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts = content.flatMap((part) => {
    const record = asRecord(part);
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  });
  return texts.length > 0 ? texts.join("") : undefined;
}

export function isAssistantRunEvent(event: OpenClawEvent): boolean {
  return (
    Boolean(event.raw) && (event.type === "assistant.delta" || event.type === "assistant.message")
  );
}

export function isTerminalRunEvent(event: OpenClawEvent): boolean {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.timed_out"
  );
}

export function normalizeChatProjectionEvent(
  event: OpenClawEvent,
  projection: ChatProjection,
  previousText: string | undefined,
): OpenClawEvent {
  const { payload, state } = projection;
  const text = readChatProjectionText(payload);
  if (state === "delta") {
    const deltaText = typeof payload.deltaText === "string" ? payload.deltaText : undefined;
    let delta = previousText !== undefined ? (deltaText ?? text) : text;
    let replace = payload.replace === true;
    if (
      text !== undefined &&
      previousText !== undefined &&
      asRecord(event.raw?.payload).message !== undefined
    ) {
      replace ||= !text.startsWith(previousText);
      delta = replace ? text : text.slice(previousText.length);
    }
    return {
      ...event,
      type: "assistant.delta",
      data:
        text === undefined
          ? event.data
          : {
              text,
              delta,
              ...(replace ? { replace: true } : {}),
            },
    };
  }
  const error = readNonEmptyString(payload.errorMessage);
  const stopReason = readNonEmptyString(payload.stopReason);
  // Gateway timeout aborts publish this mechanical chat frame before lifecycle.
  const type =
    state === "final"
      ? "run.completed"
      : state === "aborted"
        ? resolveSdkLifecycleEventType({ aborted: true, status: "cancelled", stopReason }, "end")
        : payload.errorKind === "timeout"
          ? "run.timed_out"
          : "run.failed";
  return {
    ...event,
    type,
    data: {
      phase: state === "error" ? "error" : "end",
      ...(state === "aborted" ? { aborted: true } : {}),
      ...(text !== undefined ? { outputText: text } : {}),
      ...(error ? { error } : {}),
      ...(stopReason ? { stopReason } : {}),
    },
  };
}
