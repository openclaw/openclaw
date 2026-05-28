import { describe, expect, it } from "vitest";
import { buildSessionDetailPanel, type SessionDetailItem } from "./session-panel.js";

describe("telegram-ui session panel", () => {
  it("uses Chinese token label in session detail panel", () => {
    const panel = buildSessionDetailPanel({
      token: "abc123",
      key: "sess/demo",
      displayName: "Demo",
      totalTokens: 1200,
      modelProvider: "openai",
      model: "gpt-5.4-mini",
      hasActiveRun: false,
      updatedAt: 0,
    } satisfies SessionDetailItem);

    const textBlock = panel.blocks.find((block) => block.type === "text");
    expect(textBlock?.text).toContain("權杖：1,200");
    expect(textBlock?.text).not.toContain("Token：");
  });
});
