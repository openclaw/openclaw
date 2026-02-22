import { afterEach, describe, expect, it, vi } from "vitest";
import { collectProviderApiKeys } from "./live-auth-keys.js";

describe("collectProviderApiKeys", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes line breaks in single-key env vars", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-123\n456");
    expect(collectProviderApiKeys("anthropic")).toEqual(["sk-test-123456"]);
  });

  it("filters undefined-like values", () => {
    vi.stubEnv("OPENAI_API_KEY", "undefined");
    vi.stubEnv("OPENAI_API_KEYS", "sk-one,sk-two");
    expect(collectProviderApiKeys("openai")).toEqual(["sk-one", "sk-two"]);
  });
});
