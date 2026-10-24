import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
import type { ChannelAccountSnapshot } from "../api.js";
import { linePlugin } from "../channel-plugin-api.js";
import { lineAccount, lineConfig as config } from "./channel-account.test-support.js";
import { LineConfigSchema } from "./config-schema.js";
import { lineStatusAdapter } from "./status.js";
const listPeers = linePlugin.directory!.listPeers!;
const listGroups = linePlugin.directory!.listGroups!;
const runtime = createRuntimeEnv();
const user = `U${"1".repeat(32)}`;
const groupSender = `U${"2".repeat(32)}`;
const roomSender = `U${"3".repeat(32)}`;
const group = `C${"5".repeat(32)}`;
const room = `R${"6".repeat(32)}`;
const directoryConfig = config({
  allowFrom: [user, `line:user:${user}`, "*", "accessGroup:operators"],
  groupAllowFrom: [groupSender, user],
  groups: {
    [`group:${group}`]: { allowFrom: [roomSender] },
    [group]: {},
    [`room:${room}`]: {},
    "*": { requireMention: false },
  },
});

it.each([
  ["user", listPeers, [user, groupSender, roomSender]],
  ["group", listGroups, [group, room]],
] as const)("lists unique normalized %s IDs from configured scopes", async (kind, list, ids) => {
  expect(await list({ cfg: directoryConfig, accountId: "default", runtime })).toEqual(
    ids.map((id) => ({ kind, id })),
  );
});

it("leaves an unconfigured directory empty", async () => {
  expect(await listPeers({ cfg: {}, runtime })).toEqual([]);
  expect(await listGroups({ cfg: {}, runtime })).toEqual([]);
});
const allowlist = linePlugin.allowlist;

it("reads dm/group allowlists and group overrides from line config", () => {
  const cfg = config({
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: ["Ualice"],
    groupAllowFrom: ["Ubob"],
    groups: { Cgroup1: { allowFrom: ["Ucarol"] } },
  });

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
    cfg: {},
    parsedConfig,
    accountId: "default",
    scope: "dm",
    action: "add",
    entry: "line:user:Ufrank",
  });

  expect(result).toMatchObject({ kind: "ok", changed: false });
  expect(parsedConfig).toMatchObject({ channels: { line: { allowFrom: ["Ufrank"] } } });
});
const collect = lineStatusAdapter.collectStatusIssues!;
const issue = { channel: "line", accountId: "default", kind: "config" };
function snapshot(probe: ChannelAccountSnapshot["probe"]): ChannelAccountSnapshot {
  return { accountId: "default", enabled: true, configured: true, tokenSource: "config", probe };
}
function expectIssue(issues: ReturnType<typeof collect>, message: string, fix?: string) {
  expect(issues).toEqual([{ ...issue, message, ...(fix === undefined ? {} : { fix }) }]);
}

it("keeps an opaque webhook route out of snapshots and remediation", async () => {
  const account = await lineStatusAdapter.buildAccountSnapshot!({
    cfg: {},
    account: lineAccount({ webhookPath: "hooks/line-primary/" }),
    probe: { ok: true, webhook: { status: "unset" } },
  });
  const issues = collect([account]);
  expect(JSON.stringify({ account, issues })).not.toContain("hooks/line-primary");
  expectIssue(
    issues,
    "LINE is not delivering webhook events: this channel has no webhook URL registered.",
    "register your gateway's public HTTPS URL for the route in channels.line.webhookPath (default /line/webhook) in the channel's Messaging API tab in the LINE Developers Console, then turn Use webhook on",
  );
});

it("reports a registered webhook that is switched off", () => {
  expectIssue(
    collect([snapshot({ ok: true, webhook: { status: "disabled" } })]),
    "LINE is not delivering webhook events: this channel's webhook URL is registered but switched off.",
    "turn Use webhook on in the channel's Messaging API tab in the LINE Developers Console",
  );
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
  expectIssue(
    collect([{ accountId: "default", configured: false, tokenSource: "env" }]),
    "LINE channel secret not configured",
  );
});
it("accepts configured modes and lets an account override the channel", () => {
  const cfg = config(
    LineConfigSchema.parse({
      channelAccessToken: "token",
      replyToMode: "all",
      accounts: { work: { channelAccessToken: "work-token", replyToMode: "first" } },
    }),
  );
  const resolve = linePlugin.threading!.resolveReplyToMode!;
  expect(resolve({ cfg, accountId: "work", chatType: "group" })).toBe("first");
  expect(resolve({ cfg, chatType: "group" })).toBe("all");
});
