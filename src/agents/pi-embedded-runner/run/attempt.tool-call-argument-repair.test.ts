import { describe, expect, it } from "vitest";
import { shouldRepairMalformedToolCallArguments } from "./attempt.tool-call-argument-repair.js";

describe("shouldRepairMalformedToolCallArguments", () => {
  it("keeps the repair enabled for kimi providers on anthropic-messages", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "kimi-coding",
        modelApi: "anthropic-messages",
      }),
    ).toBe(true);
  });

  it("enables the repair for openai-completions even when the provider is not kimi", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai-compatible",
        modelApi: "openai-completions",
      }),
    ).toBe(true);
  });

  it("does not enable the repair for unrelated non-kimi transports", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai-compatible",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });

  it("keeps kimi providers off on non-anthropic non-openai-completions transports", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "kimi-coding",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });
});
