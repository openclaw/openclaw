import { describe, expect, it } from "vitest";
import { resolveRoutedModelForMessage } from "./model-routing.js";

describe("resolveRoutedModelForMessage", () => {
  it("returns undefined when disabled", () => {
    expect(
      resolveRoutedModelForMessage({
        routing: { enabled: false, simpleModel: "openai/gpt-4o-mini" },
        message: "list files",
      }),
    ).toBeUndefined();
  });

  it("routes short simple prompts to simpleModel", () => {
    expect(
      resolveRoutedModelForMessage({
        routing: {
          enabled: true,
          simpleModel: "openai/gpt-4o-mini",
          complexModel: "anthropic/claude-opus-4-5",
        },
        message: "list files in src/cron",
      }),
    ).toBe("openai/gpt-4o-mini");
  });

  it("routes complex prompts to complexModel", () => {
    expect(
      resolveRoutedModelForMessage({
        routing: {
          enabled: true,
          simpleModel: "openai/gpt-4o-mini",
          complexModel: "anthropic/claude-opus-4-5",
        },
        message: "analyze architecture and refactor the scheduler",
      }),
    ).toBe("anthropic/claude-opus-4-5");
  });
});
