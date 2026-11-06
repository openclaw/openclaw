import type { Model } from "openclaw/plugin-sdk/llm";

export function createOpenAIResponsesTestModel() {
  return {
    api: "openai-responses",
    provider: "openai",
    id: "gpt-5.4",
    baseUrl: "https://api.openai.com/v1",
  } as Model<"openai-responses">;
}
