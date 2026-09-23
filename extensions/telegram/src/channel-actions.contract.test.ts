// Telegram tests cover channel actions.contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { telegramPlugin } from "../api.js";

describe("telegram actions contract", () => {
  it("requires send and poll permission on the same discoverable account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          defaultAccount: "senderOnly",
          actions: { sendMessage: false, poll: false },
          accounts: {
            senderOnly: {
              botToken: "tok-send",
              actions: { sendMessage: true, poll: false },
            },
            pollOnly: {
              botToken: "tok-poll",
              actions: { sendMessage: false, poll: true },
            },
          },
        },
      },
    };
    for (const [accountId, sends] of [
      [undefined, true],
      ["senderOnly", true],
      ["pollOnly", false],
    ] as const) {
      const actions = telegramPlugin.actions?.describeMessageTool?.({ cfg, accountId })?.actions;
      expect(actions?.includes("send")).toBe(sends);
      expect(actions).not.toContain("poll");
    }
  });

  it("keeps root and selected-account action gates distinct", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          botToken: "tok-default",
          actions: { reactions: false, poll: true },
          accounts: {
            work: {
              botToken: "tok-work",
              actions: { sendMessage: false, reactions: true, poll: false, sticker: true },
            },
          },
        },
      },
    };
    const root = telegramPlugin.actions?.describeMessageTool?.({ cfg, accountId: "default" });
    const work = telegramPlugin.actions?.describeMessageTool?.({ cfg, accountId: "work" });
    expect(root?.actions).toEqual(expect.arrayContaining(["send", "poll"]));
    expect(root?.actions).not.toContain("react");
    expect(root?.actions).not.toContain("emoji-list");
    expect(root?.actions).not.toContain("sticker");
    const schema = root?.schema;
    const contributions = Array.isArray(schema) ? schema : schema ? [schema] : [];
    expect(contributions.some((entry) => Object.hasOwn(entry.properties, "emoji"))).toBe(false);
    expect(work?.actions).not.toContain("send");
    expect(work?.actions).not.toContain("poll");
    expect(work?.actions).toEqual(
      expect.arrayContaining(["react", "emoji-list", "sticker", "sticker-search"]),
    );
  });

  it("discovers SecretRef actions and account-scoped reaction guidance without hiding healthy siblings", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          defaultAccount: "carey-notifications",
          reactionLevel: "minimal",
          accounts: {
            "Carey Notifications": {
              botToken: { source: "exec", provider: "default", id: "telegram-carey" },
              reactionLevel: "extensive",
              actions: { reactions: false, poll: false },
            },
            default: {
              botToken: "tok-healthy",
              actions: { reactions: true, poll: true },
            },
          },
        },
      },
    };
    const scoped = telegramPlugin.actions?.describeMessageTool?.({
      cfg,
      accountId: "carey-notifications",
    });
    expect(scoped?.actions).toContain("send");
    expect(scoped?.actions).not.toContain("react");
    expect(scoped?.actions).not.toContain("poll");
    expect(telegramPlugin.actions?.describeMessageTool?.({ cfg })?.actions).toEqual(
      expect.arrayContaining(["send", "react", "poll"]),
    );
    expect(
      telegramPlugin.agentPrompt?.reactionGuidance?.({ cfg, accountId: "carey-notifications" })
        ?.level,
    ).toBe("extensive");
    expect(telegramPlugin.agentPrompt?.reactionGuidance?.({ cfg })?.level).toBe("extensive");
  });

  it("discovers root SecretRef actions and reaction guidance before credentials are resolved", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          botToken: { source: "exec", provider: "default", id: "telegram-token" },
          reactionLevel: "extensive",
          actions: { reactions: true, poll: false },
        },
      },
    };
    const discovery = telegramPlugin.actions?.describeMessageTool?.({ cfg });
    expect(discovery?.actions).toEqual(expect.arrayContaining(["send", "react"]));
    expect(discovery?.actions).not.toContain("poll");
    expect(telegramPlugin.agentPrompt?.reactionGuidance?.({ cfg })?.level).toBe("extensive");
  });

  it.each(["disabled", "tokenless", "unknown"] as const)(
    "hides actions and capabilities for a %s scoped account",
    (accountId) => {
      expect(
        telegramPlugin.actions?.describeMessageTool?.({
          cfg: {
            channels: {
              telegram: {
                ...(accountId !== "tokenless" ? { botToken: "tok-root" } : {}),
                accounts: {
                  healthy: { botToken: "tok-healthy" },
                  disabled: { enabled: false, botToken: "tok-disabled" },
                  tokenless: {},
                },
              },
            },
          },
          accountId,
        }),
      ).toEqual({ actions: [], capabilities: [], schema: null });
    },
  );

  it("exposes Telegram thread create CLI remapping through the exported plugin", () => {
    const request = telegramPlugin.actions?.resolveCliActionRequest?.({
      action: "thread-create",
      args: {
        channel: "telegram",
        target: "-1003894873578",
        threadName: "Build Updates",
        message: "hello",
      },
    });

    expect(request).toEqual({
      action: "topic-create",
      args: {
        channel: "telegram",
        target: "-1003894873578",
        name: "Build Updates",
        message: "hello",
      },
    });
  });

  it("preserves quote text when presentations use durable core delivery", async () => {
    const presentation = {
      blocks: [{ type: "text" as const, text: "Quoted chart" }],
    };
    const prepareSendPayload = telegramPlugin.actions?.prepareSendPayload;

    expect(
      await prepareSendPayload?.({
        ctx: {
          channel: "telegram",
          action: "send",
          cfg: {} as OpenClawConfig,
          params: { quoteText: "  original message\n  " },
        },
        to: "123456",
        payload: {
          text: "Chart",
          presentation,
          channelData: { telegram: { parseMode: "MarkdownV2" } },
        },
      }),
    ).toEqual({
      text: "Chart",
      presentation,
      channelData: {
        telegram: {
          parseMode: "MarkdownV2",
          quoteText: "  original message\n  ",
        },
      },
    });
    expect(
      await prepareSendPayload?.({
        ctx: {
          channel: "telegram",
          action: "send",
          cfg: {} as OpenClawConfig,
          params: { quoteText: "original message" },
        },
        to: "123456",
        payload: { text: "legacy send" },
      }),
    ).toBeNull();
    expect(
      await prepareSendPayload?.({
        ctx: {
          channel: "telegram",
          action: "send",
          cfg: {} as OpenClawConfig,
          params: { quote_text: " \nsnake case quote  " },
        },
        to: "123456",
        payload: { text: "Chart", presentation },
      }),
    ).toEqual({
      text: "Chart",
      presentation,
      channelData: { telegram: { quoteText: " \nsnake case quote  " } },
    });
  });

  it("rejects retired native buttons before prepared presentation delivery", async () => {
    const prepareSendPayload = telegramPlugin.actions?.prepareSendPayload;

    await expect(
      prepareSendPayload?.({
        ctx: {
          channel: "telegram",
          action: "send",
          cfg: {} as OpenClawConfig,
          params: { buttons: '[[{"text":"Yes","callback_data":"yes"}]]' },
        },
        to: "123456",
        payload: {
          text: "Choose",
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Yes", action: { type: "callback", value: "yes" } }],
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(/native "buttons" is unsupported.*Use presentation/);
  });
});
