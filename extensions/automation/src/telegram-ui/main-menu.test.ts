import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMainMenu, buildStartMessage } from "./main-menu.js";
import type { InteractiveReply } from "./types.js";
import { trackAction } from "./user-state.js";

function collectButtonValues(panel: InteractiveReply) {
  return panel.blocks
    .filter((block) => block.type === "buttons")
    .flatMap((block) => block.buttons.map((btn) => btn.value));
}

function collectButtonRows(panel: InteractiveReply) {
  return panel.blocks
    .filter((block) => block.type === "buttons")
    .map((block) => block.buttons.map((btn) => ({ label: btn.label, value: btn.value })));
}

describe("telegram-ui main menu", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to sc:home when recent callback exceeds 64 bytes", () => {
    const userId = 91_000_001;
    trackAction(userId, "long", `sc:${"x".repeat(80)}`);
    const panel = buildMainMenu(userId);
    expect(collectButtonValues(panel)).toContain("sc:home");
  });

  it("keeps all callbacks within telegram 64-byte limit", () => {
    const userId = 91_000_002;
    trackAction(userId, "normal", "sc:chat");
    const main = buildMainMenu(userId, {
      agentStatus: "online",
      activeWorkflows: 1,
      pendingApprovals: 2,
      cronJobsEnabled: 3,
    });
    const start = buildStartMessage();
    for (const value of [...collectButtonValues(main), ...collectButtonValues(start)]) {
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("shows pro badge when user is in OPENCLAW_TELEGRAM_PRO_USERS", () => {
    const userId = 42;
    vi.stubEnv("OPENCLAW_TELEGRAM_PRO_USERS", "42");
    const panel = buildMainMenu(userId);
    const text = panel.blocks.find((block) => block.type === "text");
    expect(text?.text).toContain("⭐ Pro");
  });

  it("shows free badge by default", () => {
    const userId = 77;
    const panel = buildMainMenu(userId);
    const text = panel.blocks.find((block) => block.type === "text");
    expect(text?.text).toContain("🆓 Free");
  });

  it("uses Chinese primary menu labels without legacy English wording", () => {
    const panel = buildMainMenu(91_000_003);
    const labels = panel.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons.map((btn) => btn.label));

    expect(labels).toContain("🔄 工作流程");
    expect(labels).toContain("🧠 切換模型");
    expect(labels).toContain("🚀 維運");
    for (const label of labels) {
      expect(label).not.toMatch(/\b(Workflow|DevOps|Model)\b/i);
    }
  });

  it("normalizes legacy English labels in recent actions", () => {
    const userId = 91_000_005;
    trackAction(userId, "Workflow DevOps Agent Codex Dashboard Model Session More", "sc:home");
    const panel = buildMainMenu(userId);
    const labels = panel.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons.map((btn) => btn.label));

    const recentLabel = labels.find((label) => label.startsWith("🕐 "));
    expect(recentLabel).toBeDefined();
    expect(recentLabel).toContain("工作流程");
    expect(recentLabel).toContain("維運");
    expect(recentLabel).toContain("智能體");
    expect(recentLabel).toContain("寫碼");
    expect(recentLabel).toContain("儀表板");
    expect(recentLabel).toContain("模型");
    expect(recentLabel).toContain("工作階段");
    expect(recentLabel).toContain("更多功能");
    expect(recentLabel).not.toMatch(
      /\b(Workflow|DevOps|Agent|Codex|Dashboard|Model|Session|More)\b/i,
    );
  });

  it("normalizes truncated legacy English labels in recent actions", () => {
    const userId = 91_000_006;
    trackAction(userId, "Workfl... DevOp... Agen... Dash... Mod... Sess... Mor...", "sc:home");
    const panel = buildMainMenu(userId);
    const labels = panel.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons.map((btn) => btn.label));

    const recentLabel = labels.find((label) => label.startsWith("🕐 "));
    expect(recentLabel).toBeDefined();
    expect(recentLabel).toContain("工作流程");
    expect(recentLabel).toContain("維運");
    expect(recentLabel).toContain("智能體");
    expect(recentLabel).toContain("儀表板");
    expect(recentLabel).toContain("模型");
    expect(recentLabel).toContain("工作階段");
    expect(recentLabel).toContain("更多功能");
    expect(recentLabel).not.toMatch(/\b(Workfl|DevOp|Agen|Dash|Mod|Sess|Mor)\b/i);
  });

  it("keeps canonical main menu button layout and callback mapping", () => {
    const panel = buildMainMenu(91_000_004);
    const rows = collectButtonRows(panel);

    expect(rows).toEqual([
      [
        { label: "💬 對話", value: "sc:chat" },
        { label: "💻 寫碼", value: "sc:code" },
        { label: "🔄 工作流程", value: "sc:wf" },
      ],
      [
        { label: "⏰ 排程", value: "sc:cron" },
        { label: "🧠 切換模型", value: "sc:model" },
        { label: "📊 狀態", value: "sc:stat" },
      ],
      [
        { label: "🚀 維運", value: "sc:devops" },
        { label: "💹 交易", value: "sc:trade" },
        { label: "🖥️ 儀表板", value: "sc:dash" },
      ],
    ]);
    for (const value of collectButtonValues(panel)) {
      expect(value.startsWith("sc:")).toBe(true);
    }
  });
});
