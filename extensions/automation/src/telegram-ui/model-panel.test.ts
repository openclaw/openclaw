import { describe, expect, it } from "vitest";
import { buildModelPanel, buildModelSwitchResult, type ModelInfo } from "./model-panel.js";
import type { InteractiveReply } from "./types.js";

function buttonValues(panel: InteractiveReply) {
  return panel.blocks
    .filter((block) => block.type === "buttons")
    .flatMap((block) => block.buttons.map((btn) => btn.value));
}

describe("telegram-ui model panel", () => {
  it("groups models by provider and limits each row to three", () => {
    const models: ModelInfo[] = [
      { id: "c1", name: "Claude 1", provider: "anthropic" },
      { id: "c2", name: "Claude 2", provider: "anthropic" },
      { id: "c3", name: "Claude 3", provider: "anthropic", isCurrent: true },
      { id: "c4", name: "Claude 4", provider: "anthropic" },
      { id: "g1", name: "GPT-5", provider: "openai" },
    ];
    const panel = buildModelPanel(models, "c3");
    const buttonBlocks = panel.blocks.filter((block) => block.type === "buttons");
    expect(buttonBlocks).toHaveLength(3);

    const firstModelRow = buttonBlocks[0];
    expect(firstModelRow?.type).toBe("buttons");
    if (!firstModelRow || firstModelRow.type !== "buttons") {
      return;
    }
    expect(firstModelRow.buttons).toHaveLength(3);
    expect(firstModelRow.buttons.map((btn) => btn.value)).toEqual([
      "sc:md:sw:c1",
      "sc:md:sw:c2",
      "sc:md:sw:c3",
    ]);
  });

  it("renders switch result actions and keeps callbacks within 64 bytes", () => {
    const success = buildModelSwitchResult("Claude 4", true);
    const failure = buildModelSwitchResult("Claude 4", false);
    for (const panel of [success, failure]) {
      for (const value of buttonValues(panel)) {
        expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });
});
