import { mapAssistantMessageStream } from "../../llm/utils/stream-wrapper.js";
import { decodeHtmlEntities } from "../../shared/html-entities.js";
import type { StreamFn } from "../runtime/index.js";
import { wrapStreamObjectEvents } from "./run/stream-wrapper.js";

function decodeHtmlEntitiesInObject(value: unknown): unknown {
  if (typeof value === "string") {
    return decodeHtmlEntities(value);
  }
  if (Array.isArray(value)) {
    return value.map(decodeHtmlEntitiesInObject);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = decodeHtmlEntitiesInObject(entry);
    }
    return result;
  }
  return value;
}

const decodedToolCallArguments = new WeakSet<object>();

function decodeToolCallArgumentsHtmlEntitiesInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; arguments?: unknown };
    if (
      typedBlock.type !== "toolCall" ||
      typeof typedBlock.arguments !== "object" ||
      !typedBlock.arguments
    ) {
      continue;
    }
    if (decodedToolCallArguments.has(typedBlock.arguments)) {
      continue;
    }
    const decoded = decodeHtmlEntitiesInObject(typedBlock.arguments) as object;
    decodedToolCallArguments.add(decoded);
    typedBlock.arguments = decoded;
  }
}

/** Wraps a stream function so tool-call arguments are decoded before consumers inspect them. */
export function createHtmlEntityToolCallArgumentDecodingWrapper(baseStreamFn: StreamFn): StreamFn {
  return (model, context, options) =>
    mapAssistantMessageStream(baseStreamFn(model, context, options), (stream) => {
      const originalResult = stream.result.bind(stream);
      stream.result = async () => {
        const message = await originalResult();
        decodeToolCallArgumentsHtmlEntitiesInMessage(message);
        return message;
      };
      // Tool execution can consume final results or partial/message events.
      return wrapStreamObjectEvents(stream, (event) => {
        decodeToolCallArgumentsHtmlEntitiesInMessage(event.partial);
        decodeToolCallArgumentsHtmlEntitiesInMessage(event.message);
      });
    });
}
