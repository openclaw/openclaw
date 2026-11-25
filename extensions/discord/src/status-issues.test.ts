import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { describe, expect, it } from "vitest";
import { collectDiscordStatusIssues } from "./status-issues.js";

const collect = (fields: Record<string, unknown>) =>
  collectDiscordStatusIssues([
    { accountId: "ops", enabled: true, configured: true, ...fields } as ChannelAccountSnapshot,
  ]);
const issue = (kind: string, message: string, fix: string) => ({
  channel: "discord",
  accountId: "ops",
  kind,
  message,
  fix,
});

describe("collectDiscordStatusIssues", () => {
  it("reports an empty guild allowlist with the resolved account config path", () => {
    const issues = collect({ groupPolicy: "allowlist", guildsConfigured: 0 });
    expect(issues).toEqual([
      issue(
        "config",
        'Discord guild messages are blocked: effective groupPolicy is "allowlist", but no guilds are configured.',
        "Add your server under channels.discord.accounts.ops.guilds. Refresh channel status after the configuration reload applies.",
      ),
    ]);
  });

  it("explains the top-level and explicit default-account guild config paths", () => {
    const issues = collect({ accountId: "default", groupPolicy: "allowlist", guildsConfigured: 0 });

    expect(issues[0]?.fix).toContain("channels.discord.guilds");
    expect(issues[0]?.fix).toContain(
      "If channels.discord.accounts.default.guilds is set, add it there instead.",
    );
    expect(issues[0]?.fix).toContain("after the configuration reload applies");
  });

  it("reports disabled message content intent and unresolved channel ids", () => {
    const issues = collect({
      application: { intents: { messageContent: "disabled" } },
      audit: { unresolvedChannels: 2 },
    });

    expect(issues).toEqual([
      issue(
        "intent",
        "Message Content Intent is disabled. Bot may not see normal channel messages.",
        "Enable Message Content Intent in Discord Dev Portal → Bot → Privileged Gateway Intents, or require mention-only operation.",
      ),
      issue(
        "config",
        "Some configured guild channels are not numeric IDs (unresolvedChannels=2). Permission audit can only check numeric channel IDs.",
        "Use numeric channel IDs as keys in channels.discord.guilds.*.channels (then rerun channels status --probe).",
      ),
    ]);
  });

  it("reports channel permission failures with match metadata", () => {
    const issues = collect({
      audit: {
        channels: [
          {
            channelId: "123",
            ok: false,
            missing: ["ViewChannel", "SendMessages"],
            error: "403",
            matchKey: "alerts",
            matchSource: "guilds.ops.channels",
          },
        ],
      },
    });

    expect(issues).toEqual([
      issue(
        "permissions",
        "Channel 123 permission check failed. missing ViewChannel, SendMessages: 403 (matchKey=alerts matchSource=guilds.ops.channels)",
        "Check that the bot role can view + send in this channel (and that channel overrides don't deny it).",
      ),
    ]);
  });
});
