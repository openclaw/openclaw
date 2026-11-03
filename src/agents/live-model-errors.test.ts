import { expect, it } from "vitest";
import { isModelNotFoundErrorMessage } from "./live-model-errors.js";

function expectMessages(expected: boolean, messages: string[]) {
  for (const message of messages) {
    expect(isModelNotFoundErrorMessage(message), message).toBe(expected);
  }
}

it("detects generic model-not-found messages", () => {
  expectMessages(true, [
    "Model not found: openai/gpt-6",
    "model_not_found",
    "The model gpt-foo does not exist.",
    "This model was not found. Choose another model in the Control UI.",
    '{"code":404,"message":"model not found"}',
    '{"error":{"message":"A stealth model. Find it here: https://example.com/model","code":404}}',
    "model: MiniMax-M2.7-highspeed not found",
    "404 No endpoints found for deepseek/deepseek-r1:free.",
    "404 page not found",
    "Error: 404 404 page not found",
    '400 Provider returned error {"code":400,"msg":"model[Alibaba-NLP/Tongyi-DeepResearch-30B-A3B] router not found"}',
    "HTTP 400 not_found_error: model: claude-3-5-haiku-20241022 (request_id: req_123)",
    '{"error":{"code":"400","message":"Param Incorrect","param":"Not supported model some-model-id"}}',
    "Not supported model some-model-id",
    // #104490: account restrictions, including the raw JSON envelope.
    "The 'gpt-5.5-pro' model is not supported when using Codex with a ChatGPT account.",
    '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.5-pro\' model is not supported when using Codex with a ChatGPT account."}}',
    "404 The free model has been deprecated. Transition to qwen/qwen3.6-plus for continued paid access.",
  ]);
  expectMessages(false, [
    "The endpoint has been deprecated. Transition to v2 API for continued access.",
    "The deployment does not exist or you do not have access.",
    '{"error":{"message":"Resource missing","code":404}}',
    "This model is not supported for tool calling.",
    "This model is not supported when using tool calling.",
    "This model does not support image inputs.",
    "HTTP 404: No endpoints found that support image input",
    "Reasoning effort is not supported for this model.",
    "request ended without sending any chunks",
  ]);
});

it("treats a hard model deprecation as model-unavailable, not deprecation warnings", () => {
  expectMessages(true, [
    "Internal error: Model exo-free has been deprecated.",
    "The model `text-davinci-003` has been deprecated, learn more here: https://example.com",
    "This model is deprecated.",
  ]);
  expectMessages(false, [
    "The model parameter `max_tokens` is deprecated; use `max_completion_tokens`.",
    "The `model` field is deprecated.",
    "Parameter top_k is deprecated for this model.",
    "Warning: model gpt-4o-2024-05-13 is deprecated and will be removed on 2026-12-01.",
  ]);
});
