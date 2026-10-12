import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import type { ChannelAccountSnapshot } from "../api.js";
import { linePlugin } from "../channel-plugin-api.js";
import { LineConfigSchema } from "./config-schema.js";
import { lineStatusAdapter } from "./status.js";

const directory = linePlugin.directory;
if (!directory?.listPeers || !directory.listGroups) {
  throw new Error("LINE directory callbacks are missing");
}
const { listPeers, listGroups } = directory;
const runtime = createRuntimeEnv();
const user = `U${"1".repeat(32)}`;
const groupSender = `U${"2".repeat(32)}`;
const roomSender = `U${"3".repeat(32)}`;
const group = `C${"5".repeat(32)}`;
const room = `R${"6".repeat(32)}`;
const directoryConfig: OpenClawConfig = {
  channels: {
    line: {
      allowFrom: [user, `line:user:${user}`, "*", "accessGroup:operators"],
      groupAllowFrom: [groupSender, user],
      groups: {
        [`group:${group}`]: { allowFrom: [roomSender] },
        [group]: {},
        [`room:${room}`]: {},
        "*": { requireMention: false },
      },
    },
  },
};

describe("LINE configured directory", () => {
  it("lists unique sendable users from all configured sender scopes", async () => {
    expect(await listPeers({ cfg: directoryConfig, accountId: "default", runtime })).toEqual([
      { kind: "user", id: user },
      { kind: "user", id: groupSender },
      { kind: "user", id: roomSender },
    ]);
  });

  it("lists group and room IDs after config-key normalization", async () => {
    expect(await listGroups({ cfg: directoryConfig, accountId: "default", runtime })).toEqual([
      { kind: "group", id: group },
      { kind: "group", id: room },
    ]);
  });

  it("leaves an unconfigured directory empty", async () => {
    expect(await listPeers({ cfg: {}, runtime })).toEqual([]);
    expect(await listGroups({ cfg: {}, runtime })).toEqual([]);
  });
});

const allowlist = linePlugin.allowlist;

describe("line allowlist adapter", () => {
  it("reads dm/group allowlists and group overrides from line config", () => {
    const cfg = {
      channels: {
        line: {
          enabled: true,
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          allowFrom: ["Ualice"],
          groupAllowFrom: ["Ubob"],
          groups: {
            Cgroup1: { allowFrom: ["Ucarol"] },
          },
        },
      },
    } as OpenClawConfig;

    expect(allowlist?.readConfig?.({ cfg, accountId: "default" })).toEqual({
      dmAllowFrom: ["Ualice"],
      groupAllowFrom: ["Ubob"],
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      groupOverrides: [{ label: "Cgroup1", entries: ["Ucarol"] }],
    });
  });

  it("treats a line:-prefixed entry as already present via the line normalizer", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { line: { allowFrom: ["Ufrank"] } },
    };
    const result = allowlist?.applyConfigEdit?.({
      cfg: {} as OpenClawConfig,
      parsedConfig,
      accountId: "default",
      scope: "dm",
      action: "add",
      entry: "line:user:Ufrank",
    });

    expect(result).toMatchObject({ kind: "ok", changed: false });
    expect(parsedConfig).toMatchObject({ channels: { line: { allowFrom: ["Ufrank"] } } });
  });
});

const collect = lineStatusAdapter.collectStatusIssues!;
const issue = { channel: "line", accountId: "default", kind: "config" };
function snapshot(probe: ChannelAccountSnapshot["probe"]): ChannelAccountSnapshot {
  return { accountId: "default", enabled: true, configured: true, tokenSource: "config", probe };
}

describe("LINE status issues", () => {
  it("keeps an opaque webhook route out of snapshots and remediation", async () => {
    const account = await lineStatusAdapter.buildAccountSnapshot!({
      cfg: {},
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        signingSecretSource: "config",
        tokenStatus: "available",
        signingSecretStatus: "available",
        config: { webhookPath: "hooks/line-primary/" },
      },
      probe: { ok: true, webhook: { status: "unset" } },
    });
    const issues = collect([account]);
    expect(JSON.stringify(issues)).not.toContain("hooks/line-primary");
    expect(JSON.stringify(account)).not.toContain("hooks/line-primary");
    expect(issues).toEqual([
      {
        ...issue,
        message:
          "LINE is not delivering webhook events: this channel has no webhook URL registered.",
        fix: "register your gateway's public HTTPS URL for the route in channels.line.webhookPath (default /line/webhook) in the channel's Messaging API tab in the LINE Developers Console, then turn Use webhook on",
      },
    ]);
  });

  it("reports a registered webhook that is switched off", () => {
    expect(collect([snapshot({ ok: true, webhook: { status: "disabled" } })])).toEqual([
      {
        ...issue,
        message:
          "LINE is not delivering webhook events: this channel's webhook URL is registered but switched off.",
        fix: "turn Use webhook on in the channel's Messaging API tab in the LINE Developers Console",
      },
    ]);
  });

  it("leaves active and unanswered webhooks quiet", () => {
    expect(
      collect([
        snapshot({ ok: true, webhook: { status: "active" } }),
        snapshot({ ok: false, error: "timeout" }),
      ]),
    ).toStrictEqual([]);
  });

  it("reports a missing secret when a token source exists", () => {
    expect(collect([{ accountId: "default", configured: false, tokenSource: "env" }])).toEqual([
      { ...issue, message: "LINE channel secret not configured" },
    ]);
  });
});

describe("LINE reply-to mode", () => {
  it("accepts configured modes and lets an account override the channel", () => {
    const cfg = {
      channels: {
        line: LineConfigSchema.parse({
          channelAccessToken: "token",
          replyToMode: "all",
          accounts: { work: { channelAccessToken: "work-token", replyToMode: "first" } },
        }),
      },
    };
    const resolve = linePlugin.threading!.resolveReplyToMode!;
    expect(resolve({ cfg, accountId: "work", chatType: "group" })).toBe("first");
    expect(resolve({ cfg, chatType: "group" })).toBe("all");
  });
});
