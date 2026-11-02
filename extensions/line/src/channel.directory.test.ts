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
  dmPolicy: "allowlist",
  groupPolicy: "allowlist",
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
  expect(allowlist?.readConfig?.({ cfg: directoryConfig, accountId: "default" })).toEqual({
    dmAllowFrom: [user, `line:user:${user}`, "*", "accessGroup:operators"],
    groupAllowFrom: [groupSender, user],
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    groupOverrides: [{ label: `group:${group}`, entries: [roomSender] }],
  });
});

it("treats a line:-prefixed entry as already present via the line normalizer", () => {
  const parsedConfig = { channels: { line: { allowFrom: ["Ufrank"] } } };
  const result = allowlist?.applyConfigEdit?.({
    cfg: {},
    parsedConfig,
    accountId: "default",
    scope: "dm",
    action: "add",
    entry: "line:user:Ufrank",
  });

  expect(result).toMatchObject({ kind: "ok", changed: false });
  expect(parsedConfig.channels.line.allowFrom).toEqual(["Ufrank"]);
});
const collect = lineStatusAdapter.collectStatusIssues!;
const issue = { channel: "line", accountId: "default", kind: "config" };
function snapshot(probe: ChannelAccountSnapshot["probe"]): ChannelAccountSnapshot {
  return { accountId: "default", enabled: true, configured: true, tokenSource: "config", probe };
}
function expectIssue(issues: ReturnType<typeof collect>, message: string, fix?: string) {
  expect(issues).toEqual([
    {
      ...issue,
      message: expect.stringContaining(message),
      ...(fix === undefined ? {} : { fix: expect.stringContaining(fix) }),
    },
  ]);
}

it.each([
  ["unset", "no webhook URL registered", "register your gateway's public HTTPS URL"],
  ["disabled", "switched off", "turn Use webhook on"],
] as const)("reports %s without exposing the route", async (status, message, fix) => {
  const account = await lineStatusAdapter.buildAccountSnapshot!({
    cfg: {},
    account: lineAccount({ webhookPath: "hooks/line-primary/" }),
    probe: { ok: true, webhook: { status } },
  });
  const issues = collect([account]);
  expect(JSON.stringify({ account, issues })).not.toContain("hooks/line-primary");
  expectIssue(issues, message, fix);
  expect(issues[0]?.fix).toContain("LINE Developers Console");
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
