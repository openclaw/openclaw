import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import type { AgentMessage } from "../runtime/index.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";

type Route = Parameters<typeof getHistoryLimitFromSessionKey>[2];
const account = {
  historyLimit: 9,
  dmHistoryLimit: 12,
  dms: {
    "123": { historyLimit: 22 },
    peer: { historyLimit: 41 },
    "direct:peer": { historyLimit: 31 },
    "a::b": { historyLimit: 33 },
    "a:b": { historyLimit: 43 },
    "alice:thread:123": { historyLimit: 34 },
    "alice:topic:123": { historyLimit: 35 },
    alice: { historyLimit: 44 },
  },
};
const config = {
  session: { identityLinks: { "direct:peer": ["telegram:123"] } },
  channels: {
    "z.ai": { historyLimit: 17 },
    discord: { dmHistoryLimit: 10 },
    telegram: {
      historyLimit: 8,
      dmHistoryLimit: 4,
      dms: {
        "123": { historyLimit: 99 },
        "456": { historyLimit: 98 },
        "789": { historyLimit: 0 },
        empty: {},
        "direct:peer": { historyLimit: 31 },
        peer: { historyLimit: 32 },
        "user:thread:abc": { historyLimit: 9 },
      },
      accounts: {
        work: account,
        direct: account,
        dm: account,
        group: account,
        channel: account,
        personal: { dmHistoryLimit: 19, dms: { "direct:peer": { historyLimit: 23 } } },
        sparse: { historyLimit: 50 },
        off: { historyLimit: 0, dmHistoryLimit: 0 },
        "Work Team": { historyLimit: 40, dmHistoryLimit: 41, dms: { "123": { historyLimit: 42 } } },
      },
    },
  },
} satisfies OpenClawConfig;

function peerKey(options: Partial<Parameters<typeof buildAgentPeerSessionKey>[0]>) {
  return buildAgentPeerSessionKey({
    agentId: "main",
    channel: "telegram",
    accountId: "work",
    peerId: "123",
    ...options,
  });
}
function expectLimit(
  key: string,
  expected: number | undefined,
  route?: Route,
  cfg: OpenClawConfig = config,
) {
  expect(getHistoryLimitFromSessionKey(key, cfg, route)).toBe(expected);
}

describe("getHistoryLimitFromSessionKey", () => {
  it("requires a session key and config", () => {
    expect(getHistoryLimitFromSessionKey(undefined, config)).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("telegram:dm:123", undefined)).toBeUndefined();
  });

  const cases: Array<[string, number | undefined, Route?]> = [
    ["agent:main:z-ai:channel:general", undefined],
    ["telegram:slash:123", undefined],
    ["unknown:dm:123", undefined],
    ["discord:channel:123", undefined],
    ["agent:main:main", undefined],
    ["telegram:dm:other", 4],
    ["agent:main:telegram:dm:other", 4],
    ["telegram:direct:other", 4],
    ["agent:main:telegram:direct:other", 4],
    ["agent:main:telegram:dm:123:thread:999", 99],
    ["agent:main:telegram:dm:123:topic:555", 99],
    ["telegram:dm:123:thread:999", 99],
    ["agent:main:telegram:dm:user:thread:abc", 9],
    ["agent:main:telegram:work:direct:456", 12],
    ["agent:main:telegram:work:direct:123", 22],
    ["agent:main:telegram:direct:456", 98],
    ["agent:main:telegram:direct:direct:peer", 41, { accountId: "direct", peerId: "peer" }],
    ["agent:main:telegram:direct:direct:peer", 12, { accountId: "direct" }],
    ["agent:main:telegram:direct:direct:peer", 4],
    ["agent:main:telegram:direct:direct:peer", 31, { peerId: "direct:peer" }],
    ["agent:main:telegram:dm:dm:peer", 4],
    ["agent:main:telegram:direct:123", 22, { accountId: "work" }],
    ["agent:main:telegram:direct:456", 12, { accountId: "work" }],
    ["telegram:dm:empty", 4],
    ["telegram:dm:789", 0],
    ["agent:beta:telegram:channel:c1", 8],
    ["telegram:group:g1", 8],
    ["telegram:channel:c1", 9, { accountId: "work" }],
    ["telegram:group:g1", 9, { accountId: "work" }],
    ["telegram:dm:other", 12, { accountId: "work" }],
    ["telegram:dm:123", 22, { accountId: "work" }],
    ["telegram:dm:other", 4, { accountId: "sparse" }],
    ["telegram:dm:123", 99, { accountId: "sparse" }],
    ["telegram:channel:c1", 8, { accountId: "missing-account" }],
    ["telegram:channel:c1", 0, { accountId: "off" }],
    ["telegram:dm:other", 0, { accountId: "off" }],
  ];
  it.each(cases)("resolves %s as %s with route %j", (key, expected, route) =>
    expectLimit(key, expected, route),
  );

  it("returns undefined when a direct history limit is absent", () => {
    expect(
      getHistoryLimitFromSessionKey("telegram:dm:123", {
        channels: { telegram: { historyLimit: 10 } },
      }),
    ).toBeUndefined();
  });

  it.each(["direct", "dm", "group", "channel"])(
    "resolves routed scope for an account named %s",
    (accountId) => {
      const route = { accountId, peerId: "peer", chatType: "direct" as const };
      const key = peerKey({ accountId, peerId: "peer", dmScope: "per-account-channel-peer" });
      expectLimit(key, 41, route);
      expectLimit(`${key}:thread:99`, 41, route);
      expectLimit(peerKey({ accountId, dmScope: "main" }), undefined, route);
      const groupKey = peerKey({ accountId, peerKind: "group", peerId: "direct:peer" });
      expectLimit(groupKey, 9, { ...route, chatType: "group" });
      expectLimit(groupKey, 8, { ...route, accountId: "other", chatType: "group" });
    },
  );

  it("honors linked identity and current route after identity-link or dispatch changes", () => {
    const route = { accountId: "direct", peerId: "123", chatType: "direct" as const };
    const key = peerKey({
      accountId: "direct",
      dmScope: "per-channel-peer",
      identityLinks: config.session.identityLinks,
    });
    expectLimit(key, 31, route);
    expectLimit(key, 12, route, {
      ...config,
      session: { identityLinks: { changed: ["telegram:123"] } },
    });
    expectLimit(key, 12, route, { ...config, session: {} });
    expectLimit("agent:main:telegram:direct:another", 12, route);
    expectLimit("agent:main:main", undefined, route);
    const overrideKey = peerKey({
      dmScope: "per-account-channel-peer",
      identityLinks: config.session.identityLinks,
    });
    expectLimit(overrideKey, 23, { ...route, accountId: "personal" });
    expectLimit(overrideKey, 19, { ...route, accountId: "personal", peerId: "456" });
  });

  it.each([
    ["a::b", 33],
    ["alice:thread:123", 34],
    ["alice:topic:123", 35],
  ] as const)(
    "preserves linked peer %s and known accounts after peer changes",
    (linkedPeer, expected) => {
      const cfg = { ...config, session: { identityLinks: { [linkedPeer]: ["telegram:123"] } } };
      const key = peerKey({
        dmScope: "per-account-channel-peer",
        identityLinks: cfg.session.identityLinks,
      });
      expectLimit(key, expected, { peerId: "123" }, cfg);
      expectLimit(`${key}:thread:99`, expected, { peerId: "123" }, cfg);
      expectLimit(key, 12, { peerId: "changed" }, cfg);
    },
  );

  it.each(["work-team", "Work Team", "WORK TEAM"])(
    "matches the operator-written account key for %s",
    (accountId) => {
      expectLimit("telegram:channel:c1", 40, { accountId });
      expectLimit("telegram:dm:other", 41, { accountId });
      expectLimit("telegram:dm:123", 42, { accountId });
    },
  );

  it("matches a per-DM key written with the native user id casing", () => {
    const cfg = {
      channels: { slack: { dmHistoryLimit: 50, dms: { U0123ABC: { historyLimit: 3 } } } },
    } satisfies OpenClawConfig;
    const key = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "slack",
      peerId: "U0123ABC",
      dmScope: "per-channel-peer",
    });
    expectLimit(key, 3, { peerId: "U0123ABC", chatType: "direct" }, cfg);
    expectLimit(key, 3, undefined, cfg);
    const exact = {
      channels: { slack: { dms: { ...cfg.channels.slack.dms, u0123abc: { historyLimit: 5 } } } },
    };
    expectLimit(key, 5, { peerId: "U0123ABC", chatType: "direct" }, exact);
  });
});

it("account-scoped limits change the retained transcript without affecting other accounts", () => {
  const cfg = {
    channels: { telegram: { historyLimit: 20, accounts: { "Work Team": { historyLimit: 2 } } } },
  };
  const messages: AgentMessage[] = Array.from(
    { length: 80 },
    (_, i) =>
      (i % 2 === 0
        ? { role: "user", content: `q${i / 2}` }
        : { role: "assistant", content: `a${(i - 1) / 2}` }) as AgentMessage,
  );
  const retained = (accountId: string) =>
    limitHistoryTurns(
      messages,
      getHistoryLimitFromSessionKey("agent:main:telegram:channel:c1", cfg, { accountId }),
    ).filter((message) => message.role === "user").length;
  const accountTurns = retained("work-team");
  const rootTurns = retained("other-account");
  expect(accountTurns).toBeLessThan(40);
  expect(accountTurns).toBeLessThanOrEqual(3);
  expect(rootTurns).toBeGreaterThan(accountTurns);
  expect(rootTurns).toBeLessThanOrEqual(30);
});
