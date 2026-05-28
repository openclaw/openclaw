import { describe, expect, it } from "vitest";
import type { SystemState } from "./agent-state.js";
import { buildDashboard } from "./dashboard.js";

function makeState(overrides?: Partial<SystemState>): SystemState {
  return {
    phase: "idle",
    activeTask: null,
    queuedTasks: 0,
    attentionItems: [],
    lastCompletedTask: null,
    agents: {
      claude: { status: "online", model: "claude-sonnet-4-6" },
      codex: { status: "online", model: "codex-mini" },
    },
    stats: {
      tokensToday: 0,
      tasksToday: 0,
      uptime: 0,
    },
    ...overrides,
  };
}

describe("telegram-ui dashboard", () => {
  it("uses Chinese token label on daily stats line", () => {
    const panel = buildDashboard(
      makeState({
        stats: {
          tokensToday: 1200,
          tasksToday: 2,
          uptime: 0,
        },
      }),
    );
    const text = panel.blocks.find((block) => block.type === "text")?.text ?? "";
    expect(text).toContain("📊 今日: 2 任務 ·");
    expect(text).toContain("權杖");
    expect(text).not.toContain(" tokens");
  });
});
