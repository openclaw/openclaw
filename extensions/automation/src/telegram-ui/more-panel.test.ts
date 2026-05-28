import { describe, expect, it } from "vitest";
import { buildMorePanel } from "./more-panel.js";

function collectButtonRows(panel: ReturnType<typeof buildMorePanel>) {
  return panel.blocks
    .filter((block) => block.type === "buttons")
    .map((block) => block.buttons.map((btn) => ({ label: btn.label, value: btn.value })));
}

describe("telegram-ui more panel", () => {
  it("includes pro upgrade entry", () => {
    const panel = buildMorePanel();
    const buttonValues = panel.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons.map((btn) => btn.value));
    expect(buttonValues).toContain("sc:pro");
  });

  it("keeps callback values within telegram 64-byte limit", () => {
    const panel = buildMorePanel();
    const buttonValues = panel.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons.map((btn) => btn.value));
    for (const value of buttonValues) {
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("uses Chinese labels without legacy English button wording", () => {
    const panel = buildMorePanel();
    const labels = panel.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons.map((btn) => btn.label));

    expect(labels).toContain("🔄 工作流程");
    expect(labels).toContain("🚀 維運");
    expect(labels).toContain("📊 智能體管理");
    expect(labels).toContain("🔨 程式建置");
    expect(labels).toContain("💬 工作階段");
    for (const label of labels) {
      expect(label).not.toMatch(/\b(Workflow|DevOps|Agent|Codex|Session|Model)\b/i);
    }
  });

  it("keeps canonical more-panel button layout and callback mapping", () => {
    const panel = buildMorePanel();
    const rows = collectButtonRows(panel);

    expect(rows).toEqual([
      [
        { label: "🔄 工作流程", value: "sc:wf" },
        { label: "⏰ 排程", value: "sc:cron" },
        { label: "🧠 切換模型", value: "sc:model" },
      ],
      [
        { label: "📈 交易", value: "sc:trade" },
        { label: "🚀 維運", value: "sc:devops" },
        { label: "📊 智能體管理", value: "sc:agents" },
        { label: "🖥️ 儀表板", value: "sc:dash" },
      ],
      [
        { label: "🔨 程式建置", value: "sc:build" },
        { label: "💬 工作階段", value: "sc:sess" },
        { label: "📜 對話歷史", value: "sc:history" },
      ],
      [{ label: "🗑️ 重置對話", value: "sc:reset" }],
      [{ label: "⭐ 升級專業版", value: "sc:pro" }],
      [{ label: "← 首頁", value: "sc:home" }],
    ]);
    for (const row of rows) {
      for (const button of row) {
        expect(button.value.startsWith("sc:")).toBe(true);
      }
    }
  });
});
