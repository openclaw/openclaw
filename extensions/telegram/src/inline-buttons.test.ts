import { describe, expect, it } from "vitest";
import { buildTelegramExecApprovalButtons } from "./approval-buttons.js";
import { buildTelegramInteractiveButtons, resolveTelegramInlineButtons } from "./button-types.js";
import { resolveTelegramTargetChatType } from "./inline-buttons.js";

describe("telegram approval buttons", () => {
  it("builds allow-once, allow-always, and deny buttons", () => {
    expect(buildTelegramExecApprovalButtons("fbd8daf7")).toEqual([
      [
        { text: "Allow Once", callback_data: "/approve fbd8daf7 allow-once" },
        { text: "Allow Always", callback_data: "/approve fbd8daf7 always" },
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

describe("buildTelegramInteractiveButtons", () => {
  it("maps shared buttons and selects into Telegram inline rows", () => {
    expect(
      buildTelegramInteractiveButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Approve", value: "approve", style: "success" },
              { label: "Reject", value: "reject", style: "danger" },
              { label: "Later", value: "later" },
              { label: "Archive", value: "archive" },
            ],
          },
          {
            type: "select",
            options: [{ label: "Alpha", value: "alpha" }],
          },
        ],
      }),
    ).toEqual([
      [
        { text: "Approve", callback_data: "approve", style: "success" },
        { text: "Reject", callback_data: "reject", style: "danger" },
        { text: "Later", callback_data: "later", style: undefined },
      ],
      [{ text: "Archive", callback_data: "archive", style: undefined }],
      [{ text: "Alpha", callback_data: "alpha", style: undefined }],
    ]);
  });

  it("drops shared buttons whose callback data exceeds Telegram's limit", () => {
    expect(
      buildTelegramInteractiveButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Keep", value: "keep" },
              { label: "Too long", value: `a${"b".repeat(64)}` },
            ],
          },
        ],
      }),
    ).toEqual([[{ text: "Keep", callback_data: "keep", style: undefined }]]);
  });

  it("rewrites /approve allow-always callbacks to always so plugin IDs fit Telegram limits", () => {
    const pluginApprovalId = `plugin:${"a".repeat(36)}`;
    expect(
      buildTelegramInteractiveButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow Always",
                value: `/approve ${pluginApprovalId} allow-always`,
                style: "primary",
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Allow Always",
          callback_data: `/approve ${pluginApprovalId} always`,
          style: "primary",
        },
      ],
    ]);
  });
});

describe("resolveTelegramInlineButtons", () => {
  it("prefers explicit buttons over shared interactive blocks", () => {
    const explicit = [[{ text: "Keep", callback_data: "keep" }]] as const;

    expect(
      resolveTelegramInlineButtons({
        buttons: explicit,
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Override", value: "override" }],
            },
          ],
        },
      }),
    ).toBe(explicit);
  });

  it("derives buttons from raw interactive payloads", () => {
    expect(
      resolveTelegramInlineButtons({
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Retry", value: "retry", style: "primary" }],
            },
          ],
        },
      }),
    ).toEqual([[{ text: "Retry", callback_data: "retry", style: "primary" }]]);
  });
});
