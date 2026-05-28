import { describe, expect, it } from "vitest";
import { buildProPanel } from "./pro-panel.js";

function collectButtonValues(panel: ReturnType<typeof buildProPanel>) {
  return panel.blocks
    .filter((block) => block.type === "buttons")
    .flatMap((block) => block.buttons.map((btn) => btn.value));
}

describe("telegram-ui pro panel", () => {
  it("shows upgrade action for non-pro users", () => {
    const panel = buildProPanel(false);
    const buttonValues = collectButtonValues(panel);
    expect(buttonValues).toContain("sc:pro:buy");
    expect(buttonValues).toContain("sc:pro:env");
  });

  it("does not show upgrade action for pro users", () => {
    const panel = buildProPanel(true);
    const buttonValues = collectButtonValues(panel);
    expect(buttonValues).not.toContain("sc:pro:buy");
    expect(buttonValues).toContain("sc:pro:env");
  });

  it("escapes invoice link for safe html output", () => {
    const panel = buildProPanel(false, 'https://x.example/a?x=1&y="2"<z>');
    const textBlock = panel.blocks.find((block) => block.type === "text");
    expect(textBlock?.type).toBe("text");
    if (!textBlock || textBlock.type !== "text") {
      return;
    }
    expect(textBlock.text).toContain("&amp;");
    expect(textBlock.text).toContain("&quot;");
    expect(textBlock.text).toContain("&lt;");
  });

  it("renders auth source line", () => {
    const panel = buildProPanel(true, undefined, "PRO_ALL");
    const textBlock = panel.blocks.find((block) => block.type === "text");
    expect(textBlock?.type).toBe("text");
    if (!textBlock || textBlock.type !== "text") {
      return;
    }
    expect(textBlock.text).toContain("授權來源：<code>PRO_ALL</code>");
  });

  it("uses Chinese feature wording without legacy English labels", () => {
    const panel = buildProPanel(false);
    const textBlock = panel.blocks.find((block) => block.type === "text");
    expect(textBlock?.type).toBe("text");
    if (!textBlock || textBlock.type !== "text") {
      return;
    }
    expect(textBlock.text).toContain("多智能體協作");
    expect(textBlock.text).toContain("流程視覺編輯");
    expect(textBlock.text).toContain("維運整合");
    expect(textBlock.text).not.toMatch(/\b(Agent|Workflow|DevOps)\b/i);
  });

  it("keeps callback values within telegram 64-byte limit", () => {
    const panel = buildProPanel(false);
    for (const value of collectButtonValues(panel)) {
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});
