import { describe, expect, it } from "vitest";
import { buildTelegramExecApprovalButtons } from "./approval-buttons.js";
import { resolveTelegramTargetChatType } from "./inline-buttons.js";

describe("telegram approval buttons", () => {
  it("builds allow-once, allow-always, and deny buttons", () => {
    expect(buildTelegramExecApprovalButtons("fbd8daf7")).toEqual([
      [
        { text: "Allow Once", callback_data: "/approve fbd8daf7 allow-once" },
        { text: "Allow Always", callback_data: "/approve fbd8daf7 allow-always" },
      ],
      [{ text: "Deny", callback_data: "/approve fbd8daf7 deny" }],
    ]);
  });

  it("skips buttons when callback_data exceeds Telegram's limit", () => {
    expect(buildTelegramExecApprovalButtons(`a${"b".repeat(60)}`)).toBeUndefined();
  });
});

describe("resolveTelegramTargetChatType", () => {
  it("returns 'direct' for positive numeric IDs", () => {
    expect(resolveTelegramTargetChatType("5232990709")).toBe("direct");
    expect(resolveTelegramTargetChatType("123456789")).toBe("direct");
  });

  it("returns 'group' for negative numeric IDs", () => {
    expect(resolveTelegramTargetChatType("-123456789")).toBe("group");
    expect(resolveTelegramTargetChatType("-1001234567890")).toBe("group");
  });

  it("handles telegram: prefix from normalizeTelegramMessagingTarget", () => {
    expect(resolveTelegramTargetChatType("telegram:5232990709")).toBe("direct");
    expect(resolveTelegramTargetChatType("telegram:-123456789")).toBe("group");
    expect(resolveTelegramTargetChatType("TELEGRAM:5232990709")).toBe("direct");
  });

  it("handles tg/group prefixes and topic suffixes", () => {
    expect(resolveTelegramTargetChatType("tg:5232990709")).toBe("direct");
    expect(resolveTelegramTargetChatType("telegram:group:-1001234567890")).toBe("group");
    expect(resolveTelegramTargetChatType("telegram:group:-1001234567890:topic:456")).toBe("group");
    expect(resolveTelegramTargetChatType("-1001234567890:456")).toBe("group");
  });

  it("returns 'unknown' for usernames", () => {
    expect(resolveTelegramTargetChatType("@username")).toBe("unknown");
    expect(resolveTelegramTargetChatType("telegram:@username")).toBe("unknown");
  });

  it("returns 'unknown' for empty strings", () => {
    expect(resolveTelegramTargetChatType("")).toBe("unknown");
    expect(resolveTelegramTargetChatType("   ")).toBe("unknown");
  });
});
