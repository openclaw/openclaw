import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  classifyProviderFailoverReasonWithPlugin: vi.fn(() => null),
  matchesProviderContextOverflowWithPlugin: vi.fn(() => false),
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  classifyProviderFailoverReasonWithPlugin: hoisted.classifyProviderFailoverReasonWithPlugin,
  matchesProviderContextOverflowWithPlugin: hoisted.matchesProviderContextOverflowWithPlugin,
}));

import { classifyFailoverReason, isContextOverflowError } from "./errors.js";
import {
  classifyProviderSpecificError,
  matchesProviderContextOverflow,
} from "./provider-error-patterns.js";

describe("matchesProviderContextOverflow", () => {
  it("skips provider hook dispatch for unrelated errors", () => {
    hoisted.matchesProviderContextOverflowWithPlugin.mockClear();

    expect(
      matchesProviderContextOverflow("Permission denied for /root/oc-acp-write-should-fail.txt."),
    ).toBe(false);
    expect(hoisted.matchesProviderContextOverflowWithPlugin).not.toHaveBeenCalled();
  });

  it.each([
    // AWS Bedrock
    "ValidationException: The input is too long for the model",
    "ValidationException: Input token count exceeds the maximum number of input tokens",
    "ModelStreamErrorException: Input is too long for this model",

    // Google Vertex
    "INVALID_ARGUMENT: input exceeds the maximum number of tokens",

    // Ollama
    "ollama error: context length exceeded, too many tokens",

    // Mistral
    "mistral: input is too long for this model",

    // Cohere
    "total tokens exceeds the model's maximum limit of 4096",

    // Generic
    "input is too long for model gpt-5.4",
  ])("matches provider-specific overflow: %s", (msg) => {
    expect(matchesProviderContextOverflow(msg)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    hoisted.matchesProviderContextOverflowWithPlugin.mockClear();
    expect(matchesProviderContextOverflow("rate limit exceeded")).toBe(false);
    expect(matchesProviderContextOverflow("invalid api key")).toBe(false);
    expect(matchesProviderContextOverflow("internal server error")).toBe(false);
    expect(hoisted.matchesProviderContextOverflowWithPlugin).not.toHaveBeenCalled();
  });
});

describe("classifyProviderSpecificError", () => {
  it("classifies Bedrock ThrottlingException as rate_limit", () => {
    expect(classifyProviderSpecificError("ThrottlingException: Too many requests")).toBe(
      "rate_limit",
    );
  });

  it("classifies Bedrock ModelNotReadyException as overloaded", () => {
    expect(classifyProviderSpecificError("ModelNotReadyException: model is not ready")).toBe(
      "overloaded",
    );
  });

  it("classifies Groq model_deactivated as model_not_found", () => {
    expect(classifyProviderSpecificError("model_is_deactivated")).toBe("model_not_found");
  });

  it("classifies concurrency limit as rate_limit", () => {
    expect(classifyProviderSpecificError("concurrency limit has been reached")).toBe("rate_limit");
    expect(classifyProviderSpecificError("concurrency limit reached")).toBe("rate_limit");
  });

  it("classifies Cloudflare Workers AI quota errors as rate_limit", () => {
    expect(classifyProviderSpecificError("workers_ai gateway error: quota limit exceeded")).toBe(
      "rate_limit",
    );
  });

  it("does not match generic 'model is not ready' without Bedrock prefix", () => {
    expect(classifyProviderSpecificError("model is not ready")).toBeNull();
  });

  it("returns null for unmatched errors", () => {
    expect(classifyProviderSpecificError("some random error")).toBeNull();
  });
});

describe("isContextOverflowError with provider patterns", () => {
  it("detects Bedrock ValidationException as context overflow", () => {
    expect(isContextOverflowError("ValidationException: The input is too long for the model")).toBe(
      true,
    );
  });

  it("detects Ollama context overflow", () => {
    expect(isContextOverflowError("ollama error: context length exceeded")).toBe(true);
  });

  it("still detects standard context overflow patterns", () => {
    expect(isContextOverflowError("context length exceeded")).toBe(true);
    expect(isContextOverflowError("prompt is too long: 150000 tokens > 128000 maximum")).toBe(true);
  });
});

describe("classifyFailoverReason with provider patterns", () => {
  it("classifies Bedrock ThrottlingException via provider patterns", () => {
    expect(classifyFailoverReason("ThrottlingException: Too many concurrent requests")).toBe(
      "rate_limit",
    );
  });

  it("classifies Groq model_deactivated via provider patterns", () => {
    expect(classifyFailoverReason("model_is_deactivated: this model has been deactivated")).toBe(
      "model_not_found",
    );
  });
});
