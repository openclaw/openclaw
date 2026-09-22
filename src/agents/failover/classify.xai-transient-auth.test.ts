import { describe, expect, it } from "vitest";
import { classifyFailoverReason } from "./classify.js";

describe("xAI transient auth through the full classifier", () => {
  it("retries a bare Grok Authentication required response as a timeout", () => {
    expect(
      classifyFailoverReason('401 {"error":"Authentication required"}', { provider: "xai" }),
    ).toBe("timeout");
  });

  it("does not classify a status-prefixed Grok content refusal as auth", () => {
    expect(
      classifyFailoverReason("403 I can't help with that request.", { provider: "xai" }),
    ).toBe("unclassified");
  });

  it("keeps an invalid API key on the auth path", () => {
    expect(
      classifyFailoverReason("401 Authentication required: API key is invalid", {
        provider: "xai",
      }),
    ).toBe("auth");
  });

  it("keeps a revoked key on the permanent auth path", () => {
    expect(
      classifyFailoverReason("401 Authentication required: key has been revoked", {
        provider: "xai",
      }),
    ).toBe("auth_permanent");
  });

  it("keeps proxy authentication required on the auth path", () => {
    expect(classifyFailoverReason("401 Proxy Authentication Required", { provider: "xai" })).toBe(
      "auth",
    );
  });

  it("does not retry Authentication required for a non-xAI provider", () => {
    expect(classifyFailoverReason("401 Authentication required", { provider: "openai" })).toBe(
      "auth",
    );
  });
});
