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
  options: { cfg?: OpenClawConfig; to?: string } = {},
) {
  return telegramPlugin.actions?.prepareSendPayload?.({
    ctx: { channel: "telegram", action: "send", cfg: options.cfg ?? {}, params },
    to: options.to ?? "123456",
    payload,
  });
}
const presentation = { blocks: [{ type: "text" as const, text: "Quoted chart" }] };
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
function messageToolProperties(cfg: OpenClawConfig): string[] {
  const schema = telegramPlugin.actions?.describeMessageTool?.({
    cfg,
    accountId: "default",
  })?.schema;
  const contributions = Array.isArray(schema) ? schema : schema ? [schema] : [];
  return contributions.flatMap((entry) => Object.keys(entry.properties));
}

describe("telegram actions contract", () => {
  it("discovers copy-text buttons only when Telegram inline buttons are enabled", () => {
    expect(
      messageToolProperties(
        telegramConfig({ botToken: "tok", capabilities: { inlineButtons: "allowlist" } }),
      ),
    ).toContain("copyTextButtons");
    expect(
      messageToolProperties(
        telegramConfig({ botToken: "tok", capabilities: { inlineButtons: "off" } }),
      ),
    ).not.toContain("copyTextButtons");
  });

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
    expectActions(
      cfg,
      "work",
      ["react", "emoji-list", "sticker", "sticker-search"],
      ["send", "poll"],
    );
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
      expect(
        describeActions(
          telegramConfig({
            ...(accountId !== "tokenless" ? { botToken: "tok-root" } : {}),
            accounts: {
              healthy: { botToken: "tok-healthy" },
              disabled: { enabled: false, botToken: "tok-disabled" },
              tokenless: {},
            },
          }),
          accountId,
        ),
      ).toEqual({ actions: [], capabilities: [], schema: null });
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
      expect(agentPrompt?.messageToolCapabilities?.({ cfg, accountId })).not.toContain(
        "markdownDetails",
      );
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
      text: "Chart",
      presentation,
      ...(key === "quoteText" ? { channelData: { telegram } } : {}),
    };
    expect(await prepareSend({ [key]: quote }, payload)).toEqual({
      ...payload,
      channelData: { telegram: { ...telegram, quoteText: quote } },
    });
  });

  it("leaves legacy delivery to the legacy owner", async () => {
    expect(
      await prepareSend({ quoteText: "original message" }, { text: "legacy send" }),
    ).toBeNull();
  });

  it("prepares exact Telegram copy-text buttons for durable delivery", async () => {
    const text = "  café 🦞\nnext line  ";
    await expect(
      prepareSend(
        {
          copyTextButtons: [
            { label: "Copy value", text },
            { label: "Copy ID", text: "item-42" },
          ],
        },
        { text: "Reusable value" },
      ),
    ).resolves.toEqual({
      text: "Reusable value",
      channelData: {
        telegram: {
          buttons: [
            [{ text: "Copy value", copy_text: { text } }],
            [{ text: "Copy ID", copy_text: { text: "item-42" } }],
          ],
        },
      },
    });
  });

  it("accepts the 256-Unicode-scalar Telegram copy boundary", async () => {
    const text = "🦞".repeat(256);
    await expect(
      prepareSend(
        { copyTextButtons: [{ label: "Copy boundary", text }] },
        { text: "Boundary value" },
      ),
    ).resolves.toMatchObject({
      channelData: { telegram: { buttons: [[{ copy_text: { text } }]] } },
    });
  });

  it.each([
    { value: [], error: /must contain 1-100 buttons/ },
    { value: [{ label: "Copy", text: "" }], error: /text.*1-256 characters/ },
    { value: [{ label: " ", text: "value" }], error: /label must not be blank/ },
    { value: [{ label: "Copy", text: "x".repeat(257) }], error: /text.*1-256 characters/ },
    { value: [{ label: "Copy", text: "\ud800" }], error: /valid Unicode string/ },
    {
      value: [{ label: "Copy", text: "value", callback_data: "not-allowed" }],
      error: /only label and text strings/,
    },
    {
      value: Array.from({ length: 101 }, () => ({ label: "Copy", text: "value" })),
      error: /must contain 1-100 buttons/,
    },
  ])("rejects malformed copy buttons before delivery: $error", async ({ value, error }) => {
    await expect(prepareSend({ copyTextButtons: value }, { text: "Value" })).rejects.toThrow(error);
  });

  it.each([
    {
      payload: {},
      error: /require message or media content/,
    },
    {
      payload: { text: "Choose", presentation },
      error: /cannot be combined with presentation or interactive controls/,
    },
    {
      payload: {
        text: "Choose",
        channelData: { telegram: { buttons: [[{ text: "Existing", callback_data: "existing" }]] } },
      },
      error: /cannot replace existing Telegram controls/,
    },
  ])("rejects incompatible copy-text delivery before send: $error", async ({ payload, error }) => {
    await expect(
      prepareSend({ copyTextButtons: [{ label: "Copy", text: "value" }] }, payload),
    ).rejects.toThrow(error);
  });

  it.each([
    {
      scope: "off" as const,
      to: "123456",
      error: /inline buttons are disabled/,
    },
    {
      scope: "dm" as const,
      to: "-100123456",
      error: /limited to DMs/,
    },
  ])("enforces copy-text $scope scope during prepared sends", async ({ scope, to, error }) => {
    await expect(
      prepareSend(
        { copyTextButtons: [{ label: "Copy", text: "value" }] },
        { text: "Value" },
        { cfg: telegramConfig({ botToken: "tok", capabilities: { inlineButtons: scope } }), to },
      ),
    ).rejects.toThrow(error);
  });

  it("rejects retired native buttons before prepared presentation delivery", async () => {
    await expect(
      prepareSend(
        { buttons: '[[{"text":"Yes","callback_data":"yes"}]]' },
        { text: "Choose", presentation },
      ),
    ).rejects.toThrow(/native "buttons" is unsupported.*Use presentation/);
  });
});
