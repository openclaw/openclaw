import type { Context } from "../types.js";
import { makeProviderModel } from "./provider-model.test-support.js";

export const chatgptModel = makeProviderModel("openai-chatgpt-responses", "openai", "gpt-5.5", {
  name: "GPT-5.5",
  baseUrl: "https://chatgpt.test/backend-api",
  maxTokens: 16_000,
});
export const chatgptContext: Context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

export function completedResponse(id: string) {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}
