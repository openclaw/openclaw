/**
 * Registers caller-supplied custom API stream functions with the LLM registry.
 */
import type { ApiRegistry } from "@openclaw/ai";
import type { StreamFn, StreamFunction } from "@openclaw/llm-core";
import type { Api, AssistantMessageEventStreamContract, Model } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { runPluginStreamConsumer } from "../plugins/plugin-instance-scope.js";
import { buildStreamErrorAssistantMessage } from "./stream-message-shared.js";

function isProducerStream(
  stream: ReturnType<StreamFn>,
): stream is AssistantMessageEventStreamContract {
  return (
    !("then" in stream) &&
    "push" in stream &&
    typeof stream.push === "function" &&
    "end" in stream &&
    typeof stream.end === "function"
  );
}

function adaptCustomStream(
  model: Model,
  stream: ReturnType<StreamFn>,
): AssistantMessageEventStreamContract {
  if (isProducerStream(stream)) {
    return stream;
  }

  const adapted = createAssistantMessageEventStream();
  const result = (async () => {
    try {
      // Read-only streams need a producer bridge. Retain the original stream
      // or promise owner while consuming it across a plugin reload.
      return await runPluginStreamConsumer(stream, async () => {
        const resolved = await stream;
        for await (const event of resolved) {
          adapted.push(event);
        }
        const message = await resolved.result();
        adapted.end(message);
        return message;
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const message = buildStreamErrorAssistantMessage({ model, errorMessage });
      adapted.push({ type: "error", reason: "error", error: message });
      return message;
    }
  })();
  // A terminal event settles producer completion, not the source's independently
  // repaired result. Keep those two promises distinct, as native streams do.
  adapted.result = () => result;
  return adapted;
}

/** Registers a custom API stream function when no provider already owns it. */
export function ensureCustomApiRegistered(
  registry: ApiRegistry,
  api: Api,
  streamFn: StreamFn,
): boolean {
  if (registry.getApiProvider(api)) {
    return false;
  }

  const stream: StreamFunction = (model, context, options) =>
    adaptCustomStream(model, streamFn(model, context, options));
  registry.registerApiProvider({ api, stream, streamSimple: stream }, `openclaw-custom-api:${api}`);
  return true;
}
