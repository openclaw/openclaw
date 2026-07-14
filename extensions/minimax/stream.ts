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

function hidePendingTails(
  event: AssistantMessageEvent,
  pending: Iterable<PendingText>,
): AssistantMessageEvent {
  if (!("partial" in event) || !event.partial) {
    return event;
  }
  let partial = event.partial;
  for (const state of pending) {
    const block = partial.content[state.contentIndex];
    if (block?.type === "text" && block.text.endsWith(state.value)) {
      partial = replaceText(partial, state.contentIndex, block.text.slice(0, -state.value.length));
    }
  }
  return partial === event.partial ? event : { ...event, partial };
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
  const pendingByContentIndex = new Map<number, PendingText>();
  let highestContentIndex = -1;

  const replayLiteral = (state: PendingText): AssistantMessageEvent[] => [
    replayPendingText(state.contentIndex, state.value),
    ...(state.deferredTextEnd
      ? [hidePendingTails(state.deferredTextEnd, pendingByContentIndex.values()) as TextEndEvent]
      : []),
  ];

  const flushLiteral = (contentIndex: number): AssistantMessageEvent[] => {
    const state = pendingByContentIndex.get(contentIndex);
    if (!state) {
      return [];
    }
    pendingByContentIndex.delete(contentIndex);
    return replayLiteral(state);
  };
  // A later block proves an earlier tail literal; earlier blocks may still end
  // interleaved while the final text block awaits the terminal event.
  const flushBefore = (contentIndex: number): AssistantMessageEvent[] =>
    [...pendingByContentIndex.values()]
      .filter((state) => state.contentIndex < contentIndex)
      .sort((left, right) => left.contentIndex - right.contentIndex)
      .flatMap((state) => flushLiteral(state.contentIndex));
  const flushAll = (): AssistantMessageEvent[] =>
    [...pendingByContentIndex.values()]
      .sort((left, right) => left.contentIndex - right.contentIndex)
      .flatMap((state) => flushLiteral(state.contentIndex));

  const iterator = source[Symbol.asyncIterator]();
  let sourceExhausted = false;
  let sourceFailed = false;
  try {
    while (true) {
      let next: IteratorResult<AssistantMessageEvent>;
      try {
        next = await iterator.next();
      } catch (error) {
        sourceFailed = true;
        // A thrown source has no terminal event to classify the held suffix.
        // Replay it as literal text before preserving the transport error.
        yield* flushAll();
        throw error;
      }
      if (next.done) {
        sourceExhausted = true;
        break;
      }
      const event = next.value;
      if (event.type === "done" || event.type === "error") {
        const contentIndex = terminalTextIndex(event);
        const message = event.type === "done" ? event.message : event.error;
        const cleaned = trimFinalMessage(message);
        const removesTerminalMarker = cleaned !== message;
        const terminalBlock =
          contentIndex === undefined ? undefined : cleaned.content[contentIndex];
        const terminalText = terminalBlock?.type === "text" ? terminalBlock.text : undefined;

        for (const state of [...pendingByContentIndex.values()].sort(
          (left, right) => left.contentIndex - right.contentIndex,
        )) {
          pendingByContentIndex.delete(state.contentIndex);
          if (removesTerminalMarker && state.contentIndex === contentIndex) {
            const whitespace = state.value.slice(MESSAGE_END_MARKER.length);
            if (whitespace) {
              yield replayPendingText(state.contentIndex, whitespace);
            }
            if (state.deferredTextEnd && terminalText !== undefined) {
              yield replaceTextEnd(state.deferredTextEnd, terminalText);
            }
          } else {
            yield* replayLiteral(state);
          }
        }
        yield event.type === "done" ? { ...event, message: cleaned } : { ...event, error: cleaned };
        return;
      }

      const contentIndex = eventContentIndex(event);
      const isEarlierContentBlock =
        contentIndex !== undefined && contentIndex < highestContentIndex;
      if (contentIndex !== undefined && contentIndex > highestContentIndex) {
        yield* flushBefore(contentIndex);
        highestContentIndex = contentIndex;
      }

      if (event.type === "text_delta") {
        if (isEarlierContentBlock) {
          yield hidePendingTails(event, pendingByContentIndex.values());
          continue;
        }
        if (pendingByContentIndex.get(event.contentIndex)?.deferredTextEnd) {
          yield* flushLiteral(event.contentIndex);
        }
        const previous = pendingByContentIndex.get(event.contentIndex);
        const candidate = splitTrailingCandidate((previous?.value ?? "") + event.delta);
        if (candidate.pending) {
          pendingByContentIndex.set(event.contentIndex, {
            contentIndex: event.contentIndex,
            value: candidate.pending,
          });
        } else {
          pendingByContentIndex.delete(event.contentIndex);
        }
        if (candidate.visible) {
          yield hidePendingTails(
            { ...event, delta: candidate.visible },
            pendingByContentIndex.values(),
          ) as TextDeltaEvent;
        }
        continue;
      }

      if (event.type === "text_end") {
        if (isEarlierContentBlock) {
          yield hidePendingTails(event, pendingByContentIndex.values());
          continue;
        }
        if (pendingByContentIndex.get(event.contentIndex)?.deferredTextEnd) {
          yield* flushLiteral(event.contentIndex);
        }
        const trailing = splitTrailingCandidate(event.content).pending;
        if (trailing) {
          pendingByContentIndex.set(event.contentIndex, {
            contentIndex: event.contentIndex,
            value: trailing,
            deferredTextEnd: event,
          });
        } else {
          yield* flushLiteral(event.contentIndex);
          yield hidePendingTails(event, pendingByContentIndex.values());
        }
        continue;
      }

      yield hidePendingTails(event, pendingByContentIndex.values());
    }
  } finally {
    if (!sourceExhausted && !sourceFailed) {
      await iterator.return?.();
    }
  }

  yield* flushAll();
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
