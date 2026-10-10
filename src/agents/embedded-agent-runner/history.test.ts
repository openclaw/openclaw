// Coverage for resolving channel and DM history limits from session keys.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import type { AgentMessage } from "../runtime/index.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";

describe("getHistoryLimitFromSessionKey", () => {
  it("returns undefined when sessionKey or config is undefined", () => {
    expect(getHistoryLimitFromSessionKey(undefined, {})).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("telegram:dm:123", undefined)).toBeUndefined();
  });

  it("does not read a root peer id beginning with direct as an account segment", () => {
    // A root key whose peer id starts with "direct:" has the same segment shape as
    // the account form, so inferring account scope from segment 2 alone would look
    // up dms["peer"] and silently ignore the configured dms["direct:peer"].
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 4,
          dms: { "direct:peer": { historyLimit: 31 }, peer: { historyLimit: 32 } },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      getHistoryLimitFromSessionKey("agent:main:telegram:direct:direct:peer", config, {
        peerId: "direct:peer",
      }),
    ).toBe(31);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:dm:dm:peer", config)).toBe(4);
  });

  it("lets an account dms map replace the root map instead of merging per entry", () => {
    // The account merge contract replaces the whole map, so a root peer that the
    // account map omits must fall through to the account default, not the root entry.
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 4,
          dms: { "123": { historyLimit: 99 }, "456": { historyLimit: 98 } },
          accounts: { work: { dmHistoryLimit: 11, dms: { "123": { historyLimit: 22 } } } },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      getHistoryLimitFromSessionKey("agent:main:telegram:direct:123", config, {
        accountId: "work",
      }),
    ).toBe(22);
    // 456 exists only in the root map, so the account default wins over it.
    expect(
      getHistoryLimitFromSessionKey("agent:main:telegram:direct:456", config, {
        accountId: "work",
      }),
    ).toBe(11);
    // With no account, the root map still applies.
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:direct:456", config)).toBe(98);
  });

  it.each(["dm"])("resolves routed scope for an account named %s", (accountId) => {
    const config = {
      channels: {
        telegram: {
          historyLimit: 8,
          dmHistoryLimit: 4,
          accounts: {
            [accountId]: {
              historyLimit: 9,
              dmHistoryLimit: 12,
              dms: { peer: { historyLimit: 41 }, "direct:peer": { historyLimit: 31 } },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const route = { accountId, peerId: "peer", chatType: "direct" as const };
    const sessionKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      accountId,
      peerKind: "direct",
      peerId: route.peerId,
      dmScope: "per-account-channel-peer",
    });
    expect(getHistoryLimitFromSessionKey(sessionKey, config, route)).toBe(41);
    expect(getHistoryLimitFromSessionKey(`${sessionKey}:thread:99`, config, route)).toBe(41);
    const sharedKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      accountId,
      peerId: route.peerId,
      dmScope: "main",
    });
    expect(getHistoryLimitFromSessionKey(sharedKey, config, route)).toBeUndefined();
    const groupKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      accountId,
      peerKind: "group",
      peerId: "direct:peer",
    });
    expect(getHistoryLimitFromSessionKey(groupKey, config, { ...route, chatType: "group" })).toBe(
      9,
    );
    expect(
      getHistoryLimitFromSessionKey(groupKey, config, {
        ...route,
        accountId: "other",
        chatType: "group",
      }),
    ).toBe(8);
  });

  it("does not select another peer's override after identity-link changes or a dispatch override", () => {
    const config = {
      session: { identityLinks: { "direct:peer": ["telegram:123"] } },
      channels: {
        telegram: {
          accounts: {
            direct: {
              dmHistoryLimit: 12,
              dms: { peer: { historyLimit: 41 }, "direct:peer": { historyLimit: 31 } },
            },
            personal: { dmHistoryLimit: 19, dms: { "direct:peer": { historyLimit: 23 } } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const route = { accountId: "direct", peerId: "123", chatType: "direct" as const };
    const sessionKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      accountId: route.accountId,
      peerId: route.peerId,
      dmScope: "per-channel-peer",
      identityLinks: config.session.identityLinks,
    });
    expect(getHistoryLimitFromSessionKey(sessionKey, config, route)).toBe(31);
    expect(
      getHistoryLimitFromSessionKey(
        sessionKey,
        { ...config, session: { identityLinks: { changed: ["telegram:123"] } } },
        route,
      ),
    ).toBe(12);
    expect(getHistoryLimitFromSessionKey(sessionKey, { ...config, session: {} }, route)).toBe(12);
    expect(getHistoryLimitFromSessionKey("agent:main:telegram:direct:another", config, route)).toBe(
      12,
    );
    expect(getHistoryLimitFromSessionKey("agent:main:main", config, route)).toBeUndefined();
    const overrideKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      accountId: "work",
      peerId: route.peerId,
      dmScope: "per-account-channel-peer",
      identityLinks: config.session.identityLinks,
    });
    expect(
      getHistoryLimitFromSessionKey(overrideKey, config, { ...route, accountId: "personal" }),
    ).toBe(23);
    expect(
      getHistoryLimitFromSessionKey(overrideKey, config, {
        ...route,
        accountId: "personal",
        peerId: "456",
      }),
    ).toBe(19);
  });

  it.each(["a::b"])(
    "preserves linked peer %s and known accounts after peer changes",
    (linkedPeer) => {
      const config = {
        session: { identityLinks: { [linkedPeer]: ["telegram:123"] } },
        channels: {
          telegram: {
            dmHistoryLimit: 4,
            accounts: {
              work: {
                dmHistoryLimit: 12,
                dms: {
                  [linkedPeer]: { historyLimit: 31 },
                  "a:b": { historyLimit: 41 },
                  alice: { historyLimit: 42 },
                },
              },
            },
          },
        },
      } satisfies OpenClawConfig;
      const sessionKey = buildAgentPeerSessionKey({
        agentId: "main",
        channel: "telegram",
        accountId: "work",
        peerId: "123",
        dmScope: "per-account-channel-peer",
        identityLinks: config.session.identityLinks,
      });
      expect(getHistoryLimitFromSessionKey(sessionKey, config, { peerId: "123" })).toBe(31);
      expect(
        getHistoryLimitFromSessionKey(`${sessionKey}:thread:99`, config, { peerId: "123" }),
      ).toBe(31);
      expect(getHistoryLimitFromSessionKey(sessionKey, config, { peerId: "changed" })).toBe(12);
    },
  );

  it("returns undefined for unsupported session kinds, unknown providers, and missing limits", () => {
    const config = {
      channels: {
        telegram: { historyLimit: 10 },
        discord: { dmHistoryLimit: 10 },
      },
    } as OpenClawConfig;

    expect(getHistoryLimitFromSessionKey("telegram:slash:123", config)).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("unknown:dm:123", config)).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("discord:channel:123", config)).toBeUndefined();
    expect(getHistoryLimitFromSessionKey("telegram:dm:123", config)).toBeUndefined();
  });

  it("matches an operator-written account key against the canonical routed id", () => {
    // Routing canonicalizes account ids, so "Work Team" arrives as "work-team".
    // Exact-key config lookup would miss it and silently fall back to the root.
    const config = {
      channels: {
        telegram: {
          historyLimit: 10,
          dmHistoryLimit: 15,
          dms: { "123": { historyLimit: 7 } },
          accounts: {
            "Work Team": {
              historyLimit: 40,
              dmHistoryLimit: 41,
              dms: { "123": { historyLimit: 42 } },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    for (const accountId of ["work-team", "Work Team", "WORK TEAM"]) {
      expect(getHistoryLimitFromSessionKey("telegram:channel:c1", config, { accountId })).toBe(40);
      expect(getHistoryLimitFromSessionKey("telegram:dm:999", config, { accountId })).toBe(41);
      expect(getHistoryLimitFromSessionKey("telegram:dm:123", config, { accountId })).toBe(42);
    }
    // An unrelated account still falls back to the root.
    expect(
      getHistoryLimitFromSessionKey("telegram:channel:c1", config, { accountId: "other" }),
    ).toBe(10);
  });
});

describe("account-scoped limits change the retained transcript", () => {
  // The resolver returning a different number is not the user-visible effect;
  // what matters is that the transcript actually keeps fewer turns. This drives
  // the real resolver and the real trimmer together, no mocks.
  function transcript(userTurns: number): AgentMessage[] {
    return Array.from(
      { length: userTurns * 2 },
      (_, i) =>
        (i % 2 === 0
          ? { role: "user", content: `q${i / 2}` }
          : { role: "assistant", content: `a${(i - 1) / 2}` }) as AgentMessage,
    );
  }

  function countUserTurns(messages: AgentMessage[]) {
    return messages.filter((message) => message.role === "user").length;
  }

  const cfg = {
    channels: {
      telegram: {
        historyLimit: 20,
        accounts: { "Work Team": { historyLimit: 2 } },
      },
    },
  } as unknown as OpenClawConfig;

  const sessionKey = "agent:main:telegram:channel:c1";
  const messages = transcript(40);

  it("trims to the channel root when the account does not override", () => {
    const rootLimited = limitHistoryTurns(
      messages,
      getHistoryLimitFromSessionKey(sessionKey, cfg, { accountId: "other-account" }),
    );
    const accountLimited = limitHistoryTurns(
      messages,
      getHistoryLimitFromSessionKey(sessionKey, cfg, { accountId: "work-team" }),
    );
    expect(countUserTurns(rootLimited)).toBeGreaterThan(countUserTurns(accountLimited));
    expect(countUserTurns(rootLimited)).toBeLessThanOrEqual(30);
  });
});
