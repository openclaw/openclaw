export {
  getApiProvider,
  getApiProviders,
  registerApiProvider,
  unregisterApiProviders,
} from "../llm/api-registry.js";
export { getEnvApiKey } from "../llm/env-api-keys.js";
export { calculateCost } from "../llm/model-utils.js";
export {
  streamAnthropic,
  streamSimpleOpenAICompletions,
} from "../llm/providers/register-builtins.js";
export { complete, completeSimple, stream, streamSimple } from "../llm/stream.js";
export type * from "../llm/types.js";
export {
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "../llm/utils/event-stream.js";
export { parseStreamingJson } from "../llm/utils/json-parse.js";
export type { MutableAssistantMessageEventStream } from "./stream-compat.js";
export type { AnthropicOptions } from "../llm/providers/anthropic.js";
export type { OAuthCredentials, OAuthLoginCallbacks } from "../llm/utils/oauth/types.js";
export type { OpenAICompletionsOptions } from "../llm/providers/openai-completions.js";
export {
  validateToolArguments,
  validateToolCall,
} from "../../packages/agent-core/src/validation.js";
export type { Api, Model } from "../llm/types.js";

import type { Api, Model } from "../llm/types.js";

export function getModel<TApi extends Api>(
  api: TApi,
  id: string,
  overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
  return {
    id,
    name: id,
    api,
    provider: typeof overrides.provider === "string" ? overrides.provider : api,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as Model<TApi>;
}
