import { describe, expect, it } from "vitest";

import { isApiKeyRateLimitError } from "./live-auth-keys.js";

describe("isApiKeyRateLimitError", () => {
  it("recognizes Bedrock day-token quota messages", () => {
    expect(isApiKeyRateLimitError("AWS Bedrock: Too many tokens per day. Please try again tomorrow.")).toBe(true);
    expect(isApiKeyRateLimitError("AWS Bedrock: Max tokens per day reached. Please try again tomorrow.")).toBe(true);
  });

  it("does not classify context-size token errors as rate limits", () => {
    expect(isApiKeyRateLimitError("Context window exceeded: too many tokens per request.")).toBe(false);
  });
});
