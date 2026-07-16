import "./stream.js";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context } from "openclaw/plugin-sdk/llm";

type StreamTestApi = {
  buildCopilotDynamicHeaders: (params: {
    messages: Context["messages"];
    hasImages: boolean;
  }) => Record<string, string>;
  wrapCopilotOpenAICompletionsStream: (stream: StreamFn | undefined) => StreamFn | undefined;
  wrapCopilotOpenAIResponsesStream: (stream: StreamFn | undefined) => StreamFn | undefined;
};

const api = Reflect.get(globalThis, Symbol.for("openclaw.githubCopilotStreamTestApi"));
if (!api) {
  throw new Error("GitHub Copilot stream test API is unavailable");
}

export const {
  buildCopilotDynamicHeaders,
  wrapCopilotOpenAICompletionsStream,
  wrapCopilotOpenAIResponsesStream,
} = api as StreamTestApi;
