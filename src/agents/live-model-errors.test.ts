import { describe, expect, it } from "vitest";
import {
  isMiniMaxModelNotFoundErrorMessage,
  isModelNotFoundErrorMessage,
} from "./live-model-errors.js";

describe("live model error helpers", () => {
  it("detects generic model-not-found messages", () => {
    expect(isModelNotFoundErrorMessage("Model not found: openai/gpt-6")).toBe(true);
    expect(isModelNotFoundErrorMessage("model_not_found")).toBe(true);
    expect(isModelNotFoundErrorMessage("The model gpt-foo does not exist.")).toBe(true);
    expect(isModelNotFoundErrorMessage('{"code":404,"message":"model not found"}')).toBe(true);
    expect(isModelNotFoundErrorMessage("model: MiniMax-M2.7-highspeed not found")).toBe(true);
    expect(
      isModelNotFoundErrorMessage("404 No endpoints found for deepseek/deepseek-r1:free."),
    ).toBe(true);
    expect(
      isModelNotFoundErrorMessage(
        "HTTP 400 not_found_error: model: claude-3-5-haiku-20241022 (request_id: req_123)",
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
    expect(isModelNotFoundErrorMessage("request ended without sending any chunks")).toBe(false);
  });

  it("detects bare minimax 404 page-not-found responses", () => {
    expect(isMiniMaxModelNotFoundErrorMessage("404 page not found")).toBe(true);
    expect(isMiniMaxModelNotFoundErrorMessage("Error: 404 404 page not found")).toBe(true);
    expect(isMiniMaxModelNotFoundErrorMessage("request ended without sending any chunks")).toBe(
      false,
    );
  });
});
