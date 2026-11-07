import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { telegramPlugin } from "../api.js";

const telegramConfig = (
  telegram: NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>,
): OpenClawConfig => ({ channels: { telegram } });
type PreparedSend = Parameters<
  NonNullable<NonNullable<typeof telegramPlugin.actions>["prepareSendPayload"]>
>[0];
function prepareSend(
  params: PreparedSend["ctx"]["params"],
  payload: PreparedSend["payload"],
  to = "123456",
) {
  return telegramPlugin.actions?.prepareSendPayload?.({
    ctx: { channel: "telegram", action: "send", cfg: {}, params },
    to,
    payload,
  });
}
const presentation = { blocks: [{ type: "text" as const, text: "Quoted chart" }] };
const effectId = "5104841245755180586";
const presented = { text: "Chart", presentation };
const nonPrivateTargets = ["-1001", "-1001:topic:42", "@somechannel"];
const { actions: pluginActions, agentPrompt } = telegramPlugin;
function describeActions(cfg: OpenClawConfig, accountId?: string) {
  return pluginActions?.describeMessageTool?.({ cfg, accountId });
}
function expectActions(
  cfg: OpenClawConfig,
  accountId: string | undefined,
  included: string[],
  excluded: string[],
) {
  const actions = describeActions(cfg, accountId)?.actions;
  expect(actions).toEqual(expect.arrayContaining(included));
  for (const action of excluded) {
    expect(actions).not.toContain(action);
  }
}

describe("telegram actions contract", () => {
  it("requires send and poll permission on the same discoverable account", () => {
    const cfg = telegramConfig({
      defaultAccount: "senderOnly",
      actions: { sendMessage: false, poll: false },
      accounts: {
        senderOnly: { botToken: "tok-send", actions: { sendMessage: true, poll: false } },
        pollOnly: { botToken: "tok-poll", actions: { sendMessage: false, poll: true } },
      },
    });
    for (const [accountId, sends] of [
      [undefined, true],
      ["senderOnly", true],
      ["pollOnly", false],
    ] as const) {
      const actions = describeActions(cfg, accountId)?.actions;
      expect(actions?.includes("send")).toBe(sends);
      // Dice has no gate of its own, so it appears and disappears with sendMessage.
      expect(actions?.includes("dice")).toBe(sends);
      expect(actions).not.toContain("poll");
    }
  });

  it("keeps root and selected-account action gates distinct", () => {
    const cfg = telegramConfig({
      botToken: "tok-default",
      actions: { reactions: false, poll: true },
      accounts: {
        work: {
          botToken: "tok-work",
          actions: { sendMessage: false, reactions: true, poll: false, sticker: true },
        },
      },
    });
    expectActions(cfg, "default", ["send", "poll"], ["react", "emoji-list", "sticker"]);
    const workActions = ["react", "emoji-list", "sticker", "sticker-search"];
    expectActions(cfg, "work", workActions, ["send", "poll"]);
    const schema = describeActions(cfg, "default")?.schema;
    const contributions = Array.isArray(schema) ? schema : schema ? [schema] : [];
    expect(contributions.some((entry) => Object.hasOwn(entry.properties, "emoji"))).toBe(false);
  });

  it("discovers SecretRef actions and account-scoped reaction guidance without hiding healthy siblings", () => {
    const cfg = telegramConfig({
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
    });
    expectActions(cfg, "carey-notifications", ["send"], ["react", "poll"]);
    expectActions(cfg, undefined, ["send", "react", "poll"], []);
    for (const accountId of ["carey-notifications", undefined]) {
      expect(agentPrompt?.reactionGuidance?.({ cfg, accountId })?.level).toBe("extensive");
    }
  });

  it.each(["disabled", "tokenless", "unknown"] as const)(
    "hides actions and capabilities for a %s scoped account",
    (accountId) => {
      const accounts = {
        healthy: { botToken: "tok-healthy" },
        disabled: { enabled: false, botToken: "tok-disabled" },
        tokenless: {},
      };
      const rootToken = accountId === "tokenless" ? {} : { botToken: "tok-root" };
      const cfg = telegramConfig({ ...rootToken, accounts });
      expect(describeActions(cfg, accountId)).toEqual({
        actions: [],
        capabilities: [],
        schema: null,
      });
    },
  );

  it("owns one formatting contract, chosen by the delivering account's richMessages", () => {
    const cfg = telegramConfig({
      accounts: {
        rich: { botToken: "tok-rich", richMessages: true },
        plain: { botToken: "tok-plain" },
      },
    });
    const rich = agentPrompt?.inboundFormattingHints?.({ cfg, accountId: "rich" });
    const plain = agentPrompt?.inboundFormattingHints?.({ cfg, accountId: "plain" });

    expect(rich?.text_markup).toBe("markdown_telegram_rich");
    expect(rich?.rules.join("\n")).toContain("<details>");
    expect(rich?.rules.join("\n")).toContain("Lists, checklists, and inline formatting: Markdown");
    expect(rich?.rules.join("\n")).not.toContain("<ul>");
    expect(plain?.text_markup).toBe("markdown");
    expect(plain?.rules[0]).toMatch(/^Telegram rich OFF\./);
    // `<details>` guidance lives only in the contract, not in a second capability route.
    for (const accountId of ["rich", "plain"]) {
      const capabilities = agentPrompt?.messageToolCapabilities?.({ cfg, accountId });
      expect(capabilities).not.toContain("markdownDetails");
    }
  });

  it("exposes Telegram thread create CLI remapping through the exported plugin", () => {
    const args = { channel: "telegram", target: "-1003894873578", message: "hello" };
    const request = pluginActions?.resolveCliActionRequest?.({
      action: "thread-create",
      args: { ...args, threadName: "Build Updates" },
    });

    expect(request).toEqual({
      action: "topic-create",
      args: { ...args, name: "Build Updates" },
    });
  });

  it.each([
    { key: "quoteText", quote: "  original message\n  ", telegram: { parseMode: "MarkdownV2" } },
    { key: "quote_text", quote: " \nsnake case quote  ", telegram: {} },
  ])("preserves $key on durable presentation delivery", async ({ key, quote, telegram }) => {
    const payload = {
      ...presented,
      ...(key === "quoteText" ? { channelData: { telegram } } : {}),
    };
    expect(await prepareSend({ [key]: quote, effectId }, payload)).toEqual({
      ...payload,
      channelData: { telegram: { ...telegram, quoteText: quote, messageEffectId: effectId } },
    });
  });

  it.each(nonPrivateTargets)("omits prepared effects without blocking %s", async (to) => {
    const sending = prepareSend({ effectId }, presented, to);
    await expect(sending).resolves.toEqual(presented);
  });

  it("omits non-numeric effect names without blocking delivery", async () => {
    await expect(prepareSend({ effect: "confetti" }, presented)).resolves.toEqual(presented);
  });

  it("leaves legacy delivery to the legacy owner", async () => {
    const legacy = prepareSend({ quoteText: "original", effectId }, { text: "legacy send" });
    await expect(legacy).resolves.toBeNull();
  });

  it("rejects retired native buttons before prepared presentation delivery", async () => {
    const native = { buttons: '[[{"text":"Yes","callback_data":"yes"}]]' };
    const error = /native "buttons" is unsupported.*Use presentation/;
    await expect(prepareSend(native, presented)).rejects.toThrow(error);
  });
});
