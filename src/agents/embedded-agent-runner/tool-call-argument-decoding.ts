import { mapAssistantMessageStream } from "../../llm/utils/stream-wrapper.js";
import { decodeHtmlEntities } from "../../shared/html-entities.js";
import { mapNestedStrings } from "../../shared/map-nested-strings.js";
import type { StreamFn } from "../runtime/index.js";
import { wrapStreamObjectEvents } from "./run/stream-wrapper.js";

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
    const decoded = mapNestedStrings(typedBlock.arguments, decodeHtmlEntities) as object;
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
