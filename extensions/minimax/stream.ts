// MiniMax provider module implements stream output handling.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";

const MESSAGE_END_MARKER = "[e~[";

type TextDeltaEvent = Extract<AssistantMessageEvent, { type: "text_delta" }>;
type TextEndEvent = Extract<AssistantMessageEvent, { type: "text_end" }>;
type TerminalEvent = Extract<AssistantMessageEvent, { type: "done" | "error" }>;
type AssistantStream = Awaited<ReturnType<StreamFn>>;
type PendingText = {
  contentIndex: number;
  value: string;
  deferredTextEnd?: TextEndEvent;
};

function replayPendingText(contentIndex: number, delta: string): TextDeltaEvent {
  // `text_delta.partial` is optional: replay the held tail instead of attaching
  // a snapshot that may have advanced while this wrapper waited for termination.
  return { type: "text_delta", contentIndex, delta };
}

function stripMessageEndMarker(text: string): string {
  return text.replace(/\[e~\[(\s*)$/, "$1");
}

function splitTrailingCandidate(text: string): { visible: string; pending: string } {
  const markerIndex = text.lastIndexOf(MESSAGE_END_MARKER);
  if (markerIndex >= 0 && /^\s*$/.test(text.slice(markerIndex + MESSAGE_END_MARKER.length))) {
    return { visible: text.slice(0, markerIndex), pending: text.slice(markerIndex) };
  }
  for (let length = Math.min(MESSAGE_END_MARKER.length - 1, text.length); length > 0; length -= 1) {
    if (MESSAGE_END_MARKER.startsWith(text.slice(-length))) {
      return { visible: text.slice(0, -length), pending: text.slice(-length) };
    }
  }
  return { visible: text, pending: "" };
}

function replaceText(
  message: AssistantMessage,
  contentIndex: number,
  text: string,
): AssistantMessage {
  const block = message.content[contentIndex];
  if (block?.type !== "text" || block.text === text) {
    return message;
  }
  return {
    ...message,
    content: message.content.map((content, index) =>
      index === contentIndex ? { ...block, text } : content,
    ),
  };
}

function trimFinalMessage(message: AssistantMessage): AssistantMessage {
  const contentIndex = message.content.length - 1;
  const block = message.content[contentIndex];
  return block?.type === "text"
    ? replaceText(message, contentIndex, stripMessageEndMarker(block.text))
    : message;
}

function replaceTextEnd(event: TextEndEvent, content: string): TextEndEvent {
  const partial = replaceText(event.partial, event.contentIndex, content);
  return content === event.content && partial === event.partial
    ? event
    : {
        ...event,
        content,
        partial,
      };
}

function hidePendingTail(
  event: AssistantMessageEvent,
  pending: PendingText | undefined,
): AssistantMessageEvent {
  if (!pending || !("partial" in event) || !event.partial) {
    return event;
  }
  const block = event.partial.content[pending.contentIndex];
  if (block?.type !== "text" || !block.text.endsWith(pending.value)) {
    return event;
  }
  return {
    ...event,
    partial: replaceText(
      event.partial,
      pending.contentIndex,
      block.text.slice(0, -pending.value.length),
    ),
  };
}

function terminalTextIndex(event: TerminalEvent): number | undefined {
  const message = event.type === "done" ? event.message : event.error;
  const contentIndex = message.content.length - 1;
  return message.content[contentIndex]?.type === "text" ? contentIndex : undefined;
}

function eventContentIndex(event: AssistantMessageEvent): number | undefined {
  return "contentIndex" in event ? event.contentIndex : undefined;
}

async function* transformEvents(
  source: AsyncIterable<AssistantMessageEvent>,
): AsyncGenerator<AssistantMessageEvent> {
  let pending: PendingText | undefined;

  const replayLiteral = (state: PendingText): AssistantMessageEvent[] => [
    replayPendingText(state.contentIndex, state.value),
    ...(state.deferredTextEnd ? [state.deferredTextEnd] : []),
  ];
  const flushLiteral = (): AssistantMessageEvent[] => {
    const state = pending;
    pending = undefined;
    return state ? replayLiteral(state) : [];
  };

  // StreamFn encodes provider failures as terminal error events. A thrown
  // iterator violates the agent-core contract and is not normalized here.
  for await (const event of source) {
    if (event.type === "done" || event.type === "error") {
      const contentIndex = terminalTextIndex(event);
      const message = event.type === "done" ? event.message : event.error;
      const cleaned = trimFinalMessage(message);
      const state = pending;
      pending = undefined;

      if (state && cleaned !== message && state.contentIndex === contentIndex) {
        const whitespace = state.value.slice(MESSAGE_END_MARKER.length);
        if (whitespace) {
          yield replayPendingText(state.contentIndex, whitespace);
        }
        const terminalBlock =
          contentIndex === undefined ? undefined : cleaned.content[contentIndex];
        if (state.deferredTextEnd && terminalBlock?.type === "text") {
          yield replaceTextEnd(state.deferredTextEnd, terminalBlock.text);
        }
      } else if (state) {
        yield* replayLiteral(state);
      }

      yield event.type === "done" ? { ...event, message: cleaned } : { ...event, error: cleaned };
      return;
    }

    const contentIndex = eventContentIndex(event);
    // Anthropic-compatible streams finish one content block before the next.
    // A different block therefore proves a held marker candidate is literal.
    if (pending && contentIndex !== undefined && contentIndex !== pending.contentIndex) {
      yield* flushLiteral();
    }

    if (event.type === "text_delta") {
      if (pending?.deferredTextEnd) {
        yield* flushLiteral();
      }
      const candidate = splitTrailingCandidate((pending?.value ?? "") + event.delta);
      pending = candidate.pending
        ? { contentIndex: event.contentIndex, value: candidate.pending }
        : undefined;
      if (candidate.visible) {
        yield hidePendingTail({ ...event, delta: candidate.visible }, pending) as TextDeltaEvent;
      }
      continue;
    }

    if (event.type === "text_end") {
      if (pending?.deferredTextEnd) {
        yield* flushLiteral();
      }
      const trailing = splitTrailingCandidate(event.content).pending;
      if (trailing) {
        pending = {
          contentIndex: event.contentIndex,
          value: trailing,
          deferredTextEnd: event,
        };
      } else {
        yield* flushLiteral();
        yield event;
      }
      continue;
    }

    yield hidePendingTail(event, pending);
  }

  yield* flushLiteral();
}

function wrapStream(stream: AssistantStream): AssistantStream {
  const readResult = stream.result.bind(stream);
  stream.result = async () => trimFinalMessage(await readResult());

  const createIterator = stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator] = () =>
    transformEvents({ [Symbol.asyncIterator]: createIterator })[Symbol.asyncIterator]();
  return stream;
}

export function createMinimaxMessageEndMarkerWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const maybeStream = underlying(model, context, options);
    return maybeStream && typeof maybeStream === "object" && "then" in maybeStream
      ? Promise.resolve(maybeStream).then(wrapStream)
      : wrapStream(maybeStream);
  };
}
