import { describe, expect, it } from "vitest";
import { shouldApplyMoonshotPayloadCompat } from "./moonshot-stream-wrappers.js";

describe("moonshot stream wrappers", () => {
  it("keeps Moonshot compatibility on the lightweight provider-id path", () => {
    expect(
      shouldApplyMoonshotPayloadCompat({
        provider: "moonshot",
        modelId: "kimi-k2.5",
      }),
    ).toBe(true);
    expect(
      shouldApplyMoonshotPayloadCompat({
        provider: "kimi-coding",
        modelId: "kimi-code",
      }),
    ).toBe(true);
    expect(
      shouldApplyMoonshotPayloadCompat({
        provider: "ollama",
        modelId: "kimi-k2.5:cloud",
      }),
    ).toBe(true);
    expect(
      shouldApplyMoonshotPayloadCompat({
        provider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBe(false);
  });
});
