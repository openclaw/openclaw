import { describe, expect, it } from "vitest";
import {
  classifyNotificationTier,
  formatNotificationMessage,
  shouldNotifyWithSound,
  shouldSendNewMessage,
  shouldUpdateDashboard,
} from "./notification.js";

describe("telegram-ui notification", () => {
  it("classifies tiers by context and event type", () => {
    expect(classifyNotificationTier("task_progress")).toBe("silent");
    expect(classifyNotificationTier("task_complete")).toBe("quiet");
    expect(classifyNotificationTier("task_error")).toBe("loud");
    expect(classifyNotificationTier("unknown")).toBe("quiet");
    expect(classifyNotificationTier("anything", { isError: true })).toBe("loud");
    expect(classifyNotificationTier("anything", { needsHumanInput: true })).toBe("loud");
    expect(classifyNotificationTier("anything", { isUrgent: true })).toBe("loud");
  });

  it("formats message text/silent/buttons correctly", () => {
    const quiet = formatNotificationMessage({
      id: "n1",
      tier: "quiet",
      title: "完成",
      body: "任務完成",
      actions: [{ label: "查看", callbackData: "sc:stat" }],
      source: "test",
      timestamp: Date.now(),
    });
    expect(quiet.text).toContain("📌 <b>完成</b>");
    expect(quiet.text).toContain("任務完成");
    expect(quiet.silent).toBe(false);
    expect(quiet.buttons).toEqual([{ label: "查看", value: "sc:stat" }]);

    const silent = formatNotificationMessage({
      id: "n2",
      tier: "silent",
      title: "進度",
      source: "test",
      timestamp: Date.now(),
    });
    expect(silent.silent).toBe(true);
  });

  it("applies helper policies by tier", () => {
    expect(shouldSendNewMessage("silent")).toBe(false);
    expect(shouldSendNewMessage("quiet")).toBe(true);
    expect(shouldSendNewMessage("loud")).toBe(true);

    expect(shouldNotifyWithSound("silent")).toBe(false);
    expect(shouldNotifyWithSound("quiet")).toBe(false);
    expect(shouldNotifyWithSound("loud")).toBe(true);

    expect(shouldUpdateDashboard("silent")).toBe(true);
    expect(shouldUpdateDashboard("quiet")).toBe(true);
    expect(shouldUpdateDashboard("loud")).toBe(true);
  });
});
