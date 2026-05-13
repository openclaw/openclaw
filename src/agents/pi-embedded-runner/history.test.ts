import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getHistoryLimitForSessionRouting, type HistoryLimitSessionRouting } from "./history.js";

function historyLimit(
  routing: HistoryLimitSessionRouting | undefined,
  config: OpenClawConfig | undefined,
): number | undefined {
  return getHistoryLimitForSessionRouting(routing, config);
}

describe("getHistoryLimitForSessionRouting", () => {
  it("matches channel history limits across canonical provider aliases", () => {
    expect(
      historyLimit(
        { channel: "z-ai", chatType: "channel", conversationPeerId: "general" },
        {
          channels: {
            "z.ai": {
              historyLimit: 17,
            },
          },
        },
      ),
    ).toBe(17);
  });

  it("returns undefined when routing or config is undefined", () => {
    expect(historyLimit(undefined, {})).toBeUndefined();
    expect(
      historyLimit(
        { channel: "telegram", chatType: "direct", conversationPeerId: "123" },
        undefined,
      ),
    ).toBeUndefined();
  });

  it("returns dmHistoryLimit for direct message sessions", () => {
    const config = {
      channels: {
        telegram: { dmHistoryLimit: 15 },
        whatsapp: { dmHistoryLimit: 20 },
      },
    } as OpenClawConfig;

    expect(
      historyLimit({ channel: "telegram", chatType: "direct", conversationPeerId: "123" }, config),
    ).toBe(15);
    expect(
      historyLimit({ channel: "whatsapp", chatType: "direct", conversationPeerId: "123" }, config),
    ).toBe(20);
  });

  it("uses normalized direct conversation kind when chatType is missing", () => {
    const config = {
      channels: { telegram: { dmHistoryLimit: 10 } },
    } as OpenClawConfig;

    expect(
      historyLimit(
        { channel: "telegram", conversationKind: "dm", conversationPeerId: "123" },
        config,
      ),
    ).toBe(10);
    expect(
      historyLimit(
        { channel: "telegram", conversationKind: "direct", conversationPeerId: "123" },
        config,
      ),
    ).toBe(10);
  });

  it("uses per-DM overrides before provider defaults", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 15,
          dms: {
            "123": { historyLimit: 5 },
            "456": {},
            "789": { historyLimit: 0 },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      historyLimit({ channel: "telegram", chatType: "direct", conversationPeerId: "123" }, config),
    ).toBe(5);
    expect(
      historyLimit({ channel: "telegram", chatType: "direct", conversationPeerId: "456" }, config),
    ).toBe(15);
    expect(
      historyLimit({ channel: "telegram", chatType: "direct", conversationPeerId: "789" }, config),
    ).toBe(0);
    expect(
      historyLimit(
        { channel: "telegram", chatType: "direct", conversationPeerId: "other" },
        config,
      ),
    ).toBe(15);
  });

  it("returns per-DM overrides for colon-containing provider peer ids", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 20,
          dms: { "789": { historyLimit: 3 } },
        },
        msteams: {
          dmHistoryLimit: 10,
          dms: { "user@example.com": { historyLimit: 7 } },
        },
      },
    } as OpenClawConfig;

    expect(
      historyLimit({ channel: "telegram", chatType: "direct", conversationPeerId: "789" }, config),
    ).toBe(3);
    expect(
      historyLimit(
        { channel: "msteams", chatType: "direct", conversationPeerId: "user@example.com" },
        config,
      ),
    ).toBe(7);
  });

  it("returns historyLimit for channel and group sessions", () => {
    const config = {
      channels: {
        slack: { historyLimit: 10, dmHistoryLimit: 15 },
        discord: { historyLimit: 8 },
      },
    } as OpenClawConfig;

    expect(
      historyLimit({ channel: "slack", chatType: "channel", conversationPeerId: "c1" }, config),
    ).toBe(10);
    expect(
      historyLimit({ channel: "discord", chatType: "channel", conversationPeerId: "123" }, config),
    ).toBe(8);
    expect(
      historyLimit({ channel: "discord", chatType: "group", conversationPeerId: "123" }, config),
    ).toBe(8);
  });

  it("returns undefined for unsupported routing, unknown providers, and missing limits", () => {
    const config = {
      channels: {
        telegram: { historyLimit: 10 },
        discord: { dmHistoryLimit: 10 },
      },
    } as OpenClawConfig;

    expect(
      historyLimit({ channel: "telegram", chatType: undefined, conversationPeerId: "123" }, config),
    ).toBeUndefined();
    expect(
      historyLimit({ channel: "unknown", chatType: "direct", conversationPeerId: "123" }, config),
    ).toBeUndefined();
    expect(
      historyLimit({ channel: "discord", chatType: "channel", conversationPeerId: "123" }, config),
    ).toBeUndefined();
    expect(
      historyLimit({ channel: "telegram", chatType: "direct", conversationPeerId: "123" }, config),
    ).toBeUndefined();
  });

  it("handles supported provider ids for direct and channel history limits", () => {
    const providers = [
      "telegram",
      "whatsapp",
      "discord",
      "slack",
      "signal",
      "imessage",
      "msteams",
      "nextcloud-talk",
    ] as const;

    for (const provider of providers) {
      const config = {
        channels: { [provider]: { dmHistoryLimit: 5, historyLimit: 12 } },
      } as OpenClawConfig;

      expect(
        historyLimit({ channel: provider, chatType: "direct", conversationPeerId: "123" }, config),
      ).toBe(5);
      expect(
        historyLimit({ channel: provider, chatType: "channel", conversationPeerId: "123" }, config),
      ).toBe(12);
    }
  });
});
