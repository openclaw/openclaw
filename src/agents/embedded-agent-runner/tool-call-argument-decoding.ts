/**
 * Decodes HTML-entity escaped tool-call arguments in stream wrappers.
 */
import { decodeHtmlEntities } from "../../shared/html-entities.js";
import { visitObjectContentBlocks } from "../../shared/message-content-blocks.js";
import type { StreamFn } from "../runtime/index.js";
import type { MutableAssistantMessageEventStream } from "../stream-compat.js";
import { mapAssistantMessageStream, wrapStreamObjectEvents } from "./run/stream-wrapper.js";

/**
 * Decodes HTML entities inside streamed tool-call arguments before downstream execution.
 *
 * Some providers HTML-escape JSON-ish argument strings in tool-call content blocks; this wrapper
 * repairs only arguments, preserving user-facing assistant text exactly as emitted.
 */
/** Recursively decodes HTML entities in string leaves of an object graph. */
function decodeHtmlEntitiesInObject(value: unknown): unknown {
  if (typeof value === "string") {
    return decodeHtmlEntities(value);
  }
  if (Array.isArray(value)) {
    return value.map(decodeHtmlEntitiesInObject);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = decodeHtmlEntitiesInObject(entry);
    }
    return result;
  }
  return value;
}

const decodedToolCallArguments = new WeakSet<object>();

function decodeToolCallArgumentsHtmlEntitiesInMessage(message: unknown): void {
  visitObjectContentBlocks(message, (block) => {
    const typedBlock = block as { type?: unknown; arguments?: unknown };
    if (
      typedBlock.type !== "toolCall" ||
      typeof typedBlock.arguments !== "object" ||
      !typedBlock.arguments
    ) {
      return;
    }
    if (decodedToolCallArguments.has(typedBlock.arguments)) {
      return;
    }
    const decoded = decodeHtmlEntitiesInObject(typedBlock.arguments) as object;
    decodedToolCallArguments.add(decoded);
    typedBlock.arguments = decoded;
  });
}

function wrapStreamMessageObjects(
  stream: MutableAssistantMessageEventStream,
  transformMessage: (message: unknown) => void,
): MutableAssistantMessageEventStream {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    transformMessage(message);
    return message;
  };

  // Patch both final result and streamed partial/message events. Tool execution can consume either
  // path depending on provider wrapper shape, so one-sided decoding would leave escaped args live.
  return wrapStreamObjectEvents(stream, (event) => {
    transformMessage(event.partial);
    transformMessage(event.message);
  });
}

/** Wraps a stream function so tool-call arguments are decoded before consumers inspect them. */
export function createHtmlEntityToolCallArgumentDecodingWrapper(baseStreamFn: StreamFn): StreamFn {
  return (model, context, options) =>
    mapAssistantMessageStream(baseStreamFn(model, context, options), (stream) =>
      wrapStreamMessageObjects(stream, decodeToolCallArgumentsHtmlEntitiesInMessage),
    );
}
