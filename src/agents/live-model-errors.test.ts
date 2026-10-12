// Covers provider error text classifiers used by live model validation.
import { describe, expect, it } from "vitest";
import {
  isModelNotFoundErrorMessage,
  isProviderWideModelNotFoundErrorMessage,
} from "./live-model-errors.js";

describe("live model error helpers", () => {
  it("detects generic model-not-found messages", () => {
    // Providers wrap 404/model-missing failures in inconsistent plain text and
    // JSON strings; keep matching broad enough without classifying all 404s.
    const openRouterJson404Payload =
      '{"error":{"message":"Healer Alpha was a stealth model revealed on March 18th as an early testing version of MiMo-V2-Omni. Find it here: https://openrouter.ai/xiaomi/mimo-v2-omni","code":404},"user_id":"user_33GTyP8uDSYYbaeBO48AGHXyuMC"}';

    expect(isModelNotFoundErrorMessage("Model not found: openai/gpt-6")).toBe(true);
    expect(isModelNotFoundErrorMessage("model_not_found")).toBe(true);
    expect(isModelNotFoundErrorMessage("The model gpt-foo does not exist.")).toBe(true);
    expect(
      isModelNotFoundErrorMessage(
        "This model was not found. Choose another model in the Control UI.",
      ),
    ).toBe(true);
    expect(isModelNotFoundErrorMessage('{"code":404,"message":"model not found"}')).toBe(true);
    expect(isModelNotFoundErrorMessage(openRouterJson404Payload)).toBe(true);
    expect(isModelNotFoundErrorMessage("model: MiniMax-M2.7-highspeed not found")).toBe(true);
    expect(
      isModelNotFoundErrorMessage("404 No endpoints found for deepseek/deepseek-r1:free."),
    ).toBe(true);
    expect(isModelNotFoundErrorMessage("404 page not found")).toBe(true);
    expect(isModelNotFoundErrorMessage("Error: 404 404 page not found")).toBe(true);
    expect(
      isModelNotFoundErrorMessage(
        '400 Provider returned error {"code":400,"msg":"model[Alibaba-NLP/Tongyi-DeepResearch-30B-A3B] router not found"}',
      ),
    ).toBe(true);
    expect(
      isModelNotFoundErrorMessage(
        "HTTP 400 not_found_error: model: claude-3-5-haiku-20241022 (request_id: req_123)",
      ),
    ).toBe(true);
    expect(
      isModelNotFoundErrorMessage(
        '{"error":{"code":"400","message":"Param Incorrect","param":"Not supported model some-model-id"}}',
      ),
    ).toBe(true);
    expect(isModelNotFoundErrorMessage("Not supported model some-model-id")).toBe(true);
    // #104490: account/plan-restricted model rejections (Codex + ChatGPT
    // account) are model-unavailable, including the raw JSON envelope shape.
    expect(
      isModelNotFoundErrorMessage(
        "The 'gpt-5.5-pro' model is not supported when using Codex with a ChatGPT account.",
      ),
    ).toBe(true);
    expect(
      isModelNotFoundErrorMessage(
        '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.5-pro\' model is not supported when using Codex with a ChatGPT account."}}',
      ),
    ).toBe(true);
    expect(
      isModelNotFoundErrorMessage(
        "404 The free model has been deprecated. Transition to qwen/qwen3.6-plus for continued paid access.",
      ),
    ).toBe(true);
    expect(
      isModelNotFoundErrorMessage(
        "The endpoint has been deprecated. Transition to v2 API for continued access.",
      ),
    ).toBe(false);
    expect(
      isModelNotFoundErrorMessage("The deployment does not exist or you do not have access."),
    ).toBe(false);
    expect(isModelNotFoundErrorMessage('{"error":{"message":"Resource missing","code":404}}')).toBe(
      false,
    );
    expect(isModelNotFoundErrorMessage("This model is not supported for tool calling.")).toBe(
      false,
    );
    expect(
      isModelNotFoundErrorMessage("This model is not supported when using tool calling."),
    ).toBe(false);
    expect(isModelNotFoundErrorMessage("This model does not support image inputs.")).toBe(false);
    expect(
      isModelNotFoundErrorMessage("HTTP 404: No endpoints found that support image input"),
    ).toBe(false);
    expect(isModelNotFoundErrorMessage("Reasoning effort is not supported for this model.")).toBe(
      false,
    );
    expect(isModelNotFoundErrorMessage("request ended without sending any chunks")).toBe(false);
  });

  it("treats only affirmative model absence as provider-wide", () => {
    expect(isProviderWideModelNotFoundErrorMessage("404 model not found")).toBe(true);
    expect(isProviderWideModelNotFoundErrorMessage("The model gpt-foo does not exist.")).toBe(true);
    expect(isProviderWideModelNotFoundErrorMessage("model: MiniMax-M2.7-highspeed not found")).toBe(
      true,
    );
    expect(
      isProviderWideModelNotFoundErrorMessage("The model gpt-foo is no longer available."),
    ).toBe(true);
    expect(isProviderWideModelNotFoundErrorMessage("The model gpt-foo has been retired.")).toBe(
      true,
    );
    expect(
      isProviderWideModelNotFoundErrorMessage(
        "glm-5.1 was retired at 2026-09-25 00:00:00 -0700 PDT (ref: synthetic-retirement)",
      ),
    ).toBe(true);
    expect(
      isProviderWideModelNotFoundErrorMessage(
        "Internal error: Model exo-free has been deprecated.",
      ),
    ).toBe(true);
    expect(
      isProviderWideModelNotFoundErrorMessage(
        "404 The free model has been deprecated. Transition to qwen/qwen3.6-plus for continued paid access.",
      ),
    ).toBe(true);
    expect(isModelNotFoundErrorMessage("The model does not exist or you do not have access")).toBe(
      true,
    );
    expect(isModelNotFoundErrorMessage("404 page not found")).toBe(true);
    expect(isModelNotFoundErrorMessage("not_found_error")).toBe(true);
    expect(
      isProviderWideModelNotFoundErrorMessage("The model does not exist or you do not have access"),
    ).toBe(false);
    expect(
      isProviderWideModelNotFoundErrorMessage(
        "The 'gpt-5.5-pro' model is not supported when using Codex with a ChatGPT account.",
      ),
    ).toBe(false);
    expect(isProviderWideModelNotFoundErrorMessage("current candidate model unavailable")).toBe(
      false,
    );
    expect(isProviderWideModelNotFoundErrorMessage("404 page not found")).toBe(false);
    expect(isProviderWideModelNotFoundErrorMessage("Error: 404 404 page not found")).toBe(false);
    expect(isProviderWideModelNotFoundErrorMessage("not_found_error")).toBe(false);
    expect(
      isProviderWideModelNotFoundErrorMessage(
        "HTTP 400 not_found_error: model: claude-3-5-haiku-20241022 (request_id: req_123)",
      ),
    ).toBe(false);
    expect(isProviderWideModelNotFoundErrorMessage("")).toBe(false);
    expect(isProviderWideModelNotFoundErrorMessage("   ")).toBe(false);
    expect(isProviderWideModelNotFoundErrorMessage("provider returned an unknown error")).toBe(
      false,
    );
    expect(isProviderWideModelNotFoundErrorMessage("model not found: permission denied")).toBe(
      false,
    );
    expect(
      isProviderWideModelNotFoundErrorMessage("The model gpt-foo was not found for your account"),
    ).toBe(false);
    expect(isModelNotFoundErrorMessage("model not found for this plan")).toBe(true);
    expect(isProviderWideModelNotFoundErrorMessage("model not found for this plan")).toBe(false);
    expect(isProviderWideModelNotFoundErrorMessage("model not found for this plan.")).toBe(false);
    expect(
      isProviderWideModelNotFoundErrorMessage(
        '{"error":{"message":"model not found for this plan"}}',
      ),
    ).toBe(false);
    expect(isProviderWideModelNotFoundErrorMessage("model not included in the current plan")).toBe(
      false,
    );
    expect(
      isProviderWideModelNotFoundErrorMessage("The model gpt-foo was not found for this tier"),
    ).toBe(false);
    expect(isProviderWideModelNotFoundErrorMessage("model not found for your subscription")).toBe(
      false,
    );
    expect(isProviderWideModelNotFoundErrorMessage("model not found for this membership")).toBe(
      false,
    );
    expect(isProviderWideModelNotFoundErrorMessage("model not found for this entitlement")).toBe(
      false,
    );
  });

  it("treats a hard model deprecation as model-unavailable, not deprecation warnings", () => {
    for (const message of [
      "Internal error: Model exo-free has been deprecated.",
      "The model `text-davinci-003` has been deprecated, learn more here: https://example.com",
      "This model is deprecated.",
    ]) {
      expect(isModelNotFoundErrorMessage(message), message).toBe(true);
    }
    for (const message of [
      "The model parameter `max_tokens` is deprecated; use `max_completion_tokens`.",
      "The `model` field is deprecated.",
      "Parameter top_k is deprecated for this model.",
      "Warning: model gpt-4o-2024-05-13 is deprecated and will be removed on 2026-12-01.",
    ]) {
      expect(isModelNotFoundErrorMessage(message), message).toBe(false);
    }
  });
});
