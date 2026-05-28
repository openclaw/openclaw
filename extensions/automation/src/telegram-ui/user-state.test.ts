import { describe, expect, it, vi } from "vitest";
import { getContextualGreeting, getQuickActions, setUserMode, trackAction } from "./user-state.js";

describe("telegram-ui user state", () => {
  it("keeps recent actions unique and capped to three quick actions", () => {
    const userId = 91_200_001;
    trackAction(userId, "A", "sc:a");
    trackAction(userId, "B", "sc:b");
    trackAction(userId, "C", "sc:c");
    trackAction(userId, "D", "sc:d");
    trackAction(userId, "A2", "sc:a");

    const quick = getQuickActions(userId);
    expect(quick).toHaveLength(3);
    expect(quick.map((x) => x.callbackData)).toEqual(["sc:a", "sc:d", "sc:c"]);
    expect(quick[0]?.label).toBe("A2");
  });

  it("returns mode-specific greeting suffix", () => {
    const userId = 91_200_002;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T09:00:00.000Z"));

    setUserMode(userId, "code");
    expect(getContextualGreeting(userId)).toContain("寫碼模式");
    setUserMode(userId, "chat");
    expect(getContextualGreeting(userId)).toContain("對話中");
    setUserMode(userId, "workflow");
    expect(getContextualGreeting(userId)).toContain("工作流執行中");

    vi.useRealTimers();
  });
});
