/**
 * Registers caller-supplied custom API stream functions with the LLM registry.
 */
import type { ApiRegistry } from "@openclaw/ai";
import type { AssistantMessageEventStreamLike, StreamFn, StreamFunction } from "@openclaw/llm-core";
import type { Api, AssistantMessageEventStreamContract, Model } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { runPluginStreamConsumer } from "../plugins/plugin-instance-scope.js";
import { buildStreamErrorAssistantMessage } from "./stream-message-shared.js";

/** The public StreamFn contract also admits read-only streams; only these can be returned as-is. */
function isProducerStream(
  stream: AssistantMessageEventStreamLike,
): stream is AssistantMessageEventStreamContract {
  const producer = stream as Partial<AssistantMessageEventStreamContract>;
  return typeof producer.push === "function" && typeof producer.end === "function";
}

function adaptCustomStream(
  model: Model,
  stream: ReturnType<StreamFn>,
): AssistantMessageEventStreamContract {
  if (!(stream instanceof Promise) && isProducerStream(stream)) {
    return stream;
  }

  const adapted = createAssistantMessageEventStream();
  const resolvedStream = stream instanceof Promise ? stream : Promise.resolve(stream);
  void (async () => {
    try {
      // Registry providers must return a stream immediately, while plugin
      // hooks may resolve one lazily and callers may hand back a read-only
      // stream. Bridge both lifecycles at the boundary.
      await runPluginStreamConsumer(stream, async () => {
        const resolved = await resolvedStream;
        for await (const event of resolved) {
          adapted.push(event);
        }
        adapted.end(await resolved.result());
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const message = buildStreamErrorAssistantMessage({ model, errorMessage });
      adapted.push({ type: "error", reason: "error", error: message });
    }
  })();
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
