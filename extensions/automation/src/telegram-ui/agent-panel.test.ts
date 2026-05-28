import { describe, expect, it } from "vitest";
import { buildAgentPanel, buildResetConfirm } from "./agent-panel.js";

function collectButtonValues(panel: ReturnType<typeof buildAgentPanel>) {
  return panel.blocks
    .filter((block) => block.type === "buttons")
    .flatMap((block) => block.buttons.map((btn) => btn.value));
}

describe("telegram-ui agent panel", () => {
  it("renders active marker, uptime, and escaped text", () => {
    const panel = buildAgentPanel(
      [
        {
          id: "claude",
          name: "<Claude>&",
          status: "running",
          model: 'claude"<4>&6',
          sessionTurns: 9,
          uptime: 125_000,
        },
      ],
      "claude",
    );
    const textBlock = panel.blocks.find((block) => block.type === "text");
    expect(textBlock?.type).toBe("text");
    if (!textBlock || textBlock.type !== "text") {
      return;
    }
    expect(textBlock.text).toContain("&lt;Claude&gt;&amp;");
    expect(textBlock.text).toContain('claude"&lt;4&gt;&amp;6');
    expect(textBlock.text).toContain("← 當前");
    expect(textBlock.text).toContain("上線: 2 分");
    expect(textBlock.text).toContain("智能體狀態");
    expect(textBlock.text).not.toMatch(/\bAgent\b/);
  });

  it("limits switch buttons to two and excludes active agent", () => {
    const panel = buildAgentPanel(
      [
        { id: "a", name: "A", status: "running" },
        { id: "b", name: "B", status: "idle" },
        { id: "c", name: "C", status: "error" },
        { id: "d", name: "D", status: "idle" },
      ],
      "a",
    );
    const switchButtonsBlock = panel.blocks.find(
      (block) =>
        block.type === "buttons" && block.buttons.some((btn) => btn.value.startsWith("sc:ag:sw:")),
    );
    expect(switchButtonsBlock?.type).toBe("buttons");
    if (!switchButtonsBlock || switchButtonsBlock.type !== "buttons") {
      return;
    }
    expect(switchButtonsBlock.buttons).toHaveLength(2);
    expect(switchButtonsBlock.buttons.map((btn) => btn.value)).toEqual([
      "sc:ag:sw:b",
      "sc:ag:sw:c",
    ]);
  });

  it("keeps callback values within telegram 64-byte limit", () => {
    const panel = buildAgentPanel([{ id: "a", name: "A", status: "running" }], "a");
    for (const value of collectButtonValues(panel)) {
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
    }
    const confirm = buildResetConfirm("Agent");
    const confirmValues = confirm.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons.map((btn) => btn.value));
    for (const value of confirmValues) {
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("escapes agent name in reset confirm text", () => {
    const panel = buildResetConfirm('<Agent>&"x"');
    const textBlock = panel.blocks.find((block) => block.type === "text");
    expect(textBlock?.type).toBe("text");
    if (!textBlock || textBlock.type !== "text") {
      return;
    }
    expect(textBlock.text).toContain('&lt;Agent&gt;&amp;"x"');
    expect(textBlock.text).not.toContain('<Agent>&"x"');
  });
});
