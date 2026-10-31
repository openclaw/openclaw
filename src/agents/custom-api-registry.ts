/**
 * Registers caller-supplied custom API stream functions with the LLM registry.
 */
import type { ApiRegistry } from "@openclaw/ai";
import type { StreamFn, StreamFunction } from "@openclaw/llm-core";
import type { Api, AssistantMessageEventStreamContract, Model } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { runPluginStreamConsumer } from "../plugins/plugin-instance-scope.js";
import { buildStreamErrorAssistantMessage } from "./stream-message-shared.js";

function adaptCustomStream(
  model: Model,
  stream: ReturnType<StreamFn>,
): AssistantMessageEventStreamContract {
  if (!(stream instanceof Promise)) {
    return stream as AssistantMessageEventStreamContract;
  }

  const adapted = createAssistantMessageEventStream();
  void (async () => {
    try {
      // Registry providers must return a stream immediately, while plugin
      // hooks may resolve one lazily. Bridge that lifecycle at the boundary.
      await runPluginStreamConsumer(stream, async () => {
        const resolved = await stream;
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
