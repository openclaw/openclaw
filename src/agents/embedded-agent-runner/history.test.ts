import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import type { AgentMessage } from "../runtime/index.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";

function expectHistoryLimit(...args: Parameters<typeof getHistoryLimitFromSessionKey>) {
  return expect(getHistoryLimitFromSessionKey(...args));
}

function telegramConfig(
  telegram: NonNullable<OpenClawConfig["channels"]>["telegram"],
  session?: OpenClawConfig["session"],
) {
  return { channels: { telegram }, session };
}
function peerKey(options: Partial<Parameters<typeof buildAgentPeerSessionKey>[0]>) {
  return buildAgentPeerSessionKey({
    agentId: "main",
    channel: "telegram",
    accountId: "work",
    peerId: "123",
    ...options,
  });
}

describe("getHistoryLimitFromSessionKey", () => {
  it("does not match channel history limits across provider id variants", () => {
    expectHistoryLimit("agent:main:z-ai:channel:general", {
      channels: { "z.ai": { historyLimit: 17 } },
    }).toBeUndefined();
  });

  it("returns undefined when sessionKey or config is undefined", () => {
    expectHistoryLimit(undefined, {}).toBeUndefined();
    expectHistoryLimit("telegram:dm:123", undefined).toBeUndefined();
  });

  it("keeps backward compatibility for dm and direct session kinds", () => {
    const config = telegramConfig({ dmHistoryLimit: 10 });

    expectHistoryLimit("telegram:dm:123", config).toBe(10);
    expectHistoryLimit("agent:main:telegram:dm:123", config).toBe(10);
    expectHistoryLimit("telegram:direct:123", config).toBe(10);
    expectHistoryLimit("agent:main:telegram:direct:123", config).toBe(10);
  });

  it("strips numeric thread and topic suffixes from direct message session keys", () => {
    const config = telegramConfig({ dmHistoryLimit: 10, dms: { "123": { historyLimit: 7 } } });

    expectHistoryLimit("agent:main:telegram:dm:123:thread:999", config).toBe(7);
    expectHistoryLimit("agent:main:telegram:dm:123:topic:555", config).toBe(7);
    expectHistoryLimit("telegram:dm:123:thread:999", config).toBe(7);
  });

  it("resolves account-scoped direct session keys", () => {
    const config = telegramConfig({
      dmHistoryLimit: 4,
      accounts: { work: { dmHistoryLimit: 11, dms: { "123": { historyLimit: 22 } } } },
    });

    expectHistoryLimit("agent:main:telegram:work:direct:456", config).toBe(11);
    expectHistoryLimit("agent:main:telegram:work:direct:123", config).toBe(22);
    expectHistoryLimit("agent:main:telegram:direct:456", config).toBe(4);
  });

  it("uses observed peer identity rather than the account name to resolve ambiguous keys", () => {
    const config = telegramConfig({
      dmHistoryLimit: 4,
      dms: { "direct:peer": { historyLimit: 31 } },
      accounts: { direct: { dmHistoryLimit: 12, dms: { peer: { historyLimit: 41 } } } },
    });

    expectHistoryLimit("agent:main:telegram:direct:direct:peer", config, {
      accountId: "direct",
      peerId: "peer",
    }).toBe(41);
    expectHistoryLimit("agent:main:telegram:direct:direct:peer", config, {
      accountId: "direct",
    }).toBe(12);
    expectHistoryLimit("agent:main:telegram:direct:direct:peer", config).toBe(4);
  });

  it("does not read a root peer id beginning with direct as an account segment", () => {
    const config = telegramConfig({
      dmHistoryLimit: 4,
      dms: { "direct:peer": { historyLimit: 31 }, peer: { historyLimit: 32 } },
    });

    expectHistoryLimit("agent:main:telegram:direct:direct:peer", config, {
      peerId: "direct:peer",
    }).toBe(31);
    expectHistoryLimit("agent:main:telegram:dm:dm:peer", config).toBe(4);
  });

  it("preserves a linked DM peer when its first segment matches the routed account", () => {
    const config = telegramConfig(
      {
        dmHistoryLimit: 4,
        accounts: {
          direct: {
            dmHistoryLimit: 12,
            dms: { "direct:peer": { historyLimit: 31 }, peer: { historyLimit: 41 } },
          },
        },
      },
      {
        dmScope: "per-channel-peer",
        identityLinks: { "direct:peer": ["telegram:123"] },
      },
    );
    const sessionKey = peerKey({
      accountId: "direct",
      peerKind: "direct",
      dmScope: config.session?.dmScope,
      identityLinks: config.session?.identityLinks,
    });

    expectHistoryLimit(sessionKey, config, {
      accountId: "direct",
      peerId: "123",
      chatType: "direct",
    }).toBe(31);
  });

  it("lets an account dms map replace the root map instead of merging per entry", () => {
    const config = telegramConfig({
      dmHistoryLimit: 4,
      dms: { "123": { historyLimit: 99 }, "456": { historyLimit: 98 } },
      accounts: { work: { dmHistoryLimit: 11, dms: { "123": { historyLimit: 22 } } } },
    });

    expectHistoryLimit("agent:main:telegram:direct:123", config, {
      accountId: "work",
    }).toBe(22);
    expectHistoryLimit("agent:main:telegram:direct:456", config, {
      accountId: "work",
    }).toBe(11);
    expectHistoryLimit("agent:main:telegram:direct:456", config).toBe(98);
  });

  it.each(["direct", "dm", "group", "channel"])(
    "resolves routed scope for an account named %s",
    (accountId) => {
      const config = telegramConfig({
        historyLimit: 8,
        dmHistoryLimit: 4,
        accounts: {
          [accountId]: {
            historyLimit: 9,
            dmHistoryLimit: 12,
            dms: { peer: { historyLimit: 41 }, "direct:peer": { historyLimit: 31 } },
          },
        },
      });
      const route = { accountId, peerId: "peer", chatType: "direct" as const };
      const sessionKey = peerKey({
        accountId,
        peerKind: "direct",
        peerId: route.peerId,
        dmScope: "per-account-channel-peer",
      });
      expectHistoryLimit(sessionKey, config, route).toBe(41);
      expectHistoryLimit(`${sessionKey}:thread:99`, config, route).toBe(41);
      const sharedKey = peerKey({
        accountId,
        peerId: route.peerId,
        dmScope: "main",
      });
      expectHistoryLimit(sharedKey, config, route).toBeUndefined();
      const groupKey = peerKey({
        accountId,
        peerKind: "group",
        peerId: "direct:peer",
      });
      expectHistoryLimit(groupKey, config, { ...route, chatType: "group" }).toBe(9);
      expectHistoryLimit(groupKey, config, {
        ...route,
        accountId: "other",
        chatType: "group",
      }).toBe(8);
    },
  );

  it("does not select another peer's override after identity-link changes or a dispatch override", () => {
    const config = telegramConfig(
      {
        accounts: {
          direct: {
            dmHistoryLimit: 12,
            dms: { peer: { historyLimit: 41 }, "direct:peer": { historyLimit: 31 } },
          },
          personal: { dmHistoryLimit: 19, dms: { "direct:peer": { historyLimit: 23 } } },
        },
      },
      { identityLinks: { "direct:peer": ["telegram:123"] } },
    );
    const route = { accountId: "direct", peerId: "123", chatType: "direct" as const };
    const sessionKey = peerKey({
      accountId: route.accountId,
      peerId: route.peerId,
      dmScope: "per-channel-peer",
      identityLinks: config.session?.identityLinks,
    });
    expectHistoryLimit(sessionKey, config, route).toBe(31);
    expectHistoryLimit(
      sessionKey,
      { ...config, session: { identityLinks: { changed: ["telegram:123"] } } },
      route,
    ).toBe(12);
    expectHistoryLimit(sessionKey, { ...config, session: {} }, route).toBe(12);
    expectHistoryLimit("agent:main:telegram:direct:another", config, route).toBe(12);
    expectHistoryLimit("agent:main:main", config, route).toBeUndefined();
    const overrideKey = peerKey({
      peerId: route.peerId,
      dmScope: "per-account-channel-peer",
      identityLinks: config.session?.identityLinks,
    });
    expectHistoryLimit(overrideKey, config, { ...route, accountId: "personal" }).toBe(23);
    expectHistoryLimit(overrideKey, config, {
      ...route,
      accountId: "personal",
      peerId: "456",
    }).toBe(19);
  });

  it("keeps non-numeric thread markers in direct message ids", () => {
    const config = telegramConfig({ dms: { "user:thread:abc": { historyLimit: 9 } } });

    expectHistoryLimit("agent:main:telegram:dm:user:thread:abc", config).toBe(9);
  });

  it.each(["a::b", "alice:thread:123", "alice:topic:123"])(
    "preserves linked peer %s and known accounts after peer changes",
    (linkedPeer) => {
      const config = telegramConfig(
        {
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
        { identityLinks: { [linkedPeer]: ["telegram:123"] } },
      );
      const sessionKey = peerKey({
        dmScope: "per-account-channel-peer",
        identityLinks: config.session?.identityLinks,
      });
      expectHistoryLimit(sessionKey, config, { peerId: "123" }).toBe(31);
      expectHistoryLimit(`${sessionKey}:thread:99`, config, { peerId: "123" }).toBe(31);
      expectHistoryLimit(sessionKey, config, { peerId: "changed" }).toBe(12);
    },
  );

  it("uses per-DM overrides before provider defaults", () => {
    const config = telegramConfig({
      dmHistoryLimit: 15,
      dms: {
        "123": { historyLimit: 5 },
        "456": {},
        "789": { historyLimit: 0 },
      },
    });

    expectHistoryLimit("telegram:dm:123", config).toBe(5);
    expectHistoryLimit("telegram:dm:456", config).toBe(15);
    expectHistoryLimit("telegram:dm:789", config).toBe(0);
    expectHistoryLimit("telegram:dm:other", config).toBe(15);
  });

  it("returns historyLimit for channel and group sessions", () => {
    const config = {
      channels: {
        slack: { historyLimit: 10, dmHistoryLimit: 15 },
        discord: { historyLimit: 8 },
      },
    } as OpenClawConfig;

    expectHistoryLimit("agent:beta:slack:channel:c1", config).toBe(10);
    expectHistoryLimit("discord:channel:123456", config).toBe(8);
    expectHistoryLimit("discord:group:123", config).toBe(8);
  });

  it("returns undefined for unsupported session kinds, unknown providers, and missing limits", () => {
    const config = {
      channels: {
        telegram: { historyLimit: 10 },
        discord: { dmHistoryLimit: 10 },
      },
    } as OpenClawConfig;

    expectHistoryLimit("telegram:slash:123", config).toBeUndefined();
    expectHistoryLimit("unknown:dm:123", config).toBeUndefined();
    expectHistoryLimit("discord:channel:123", config).toBeUndefined();
    expectHistoryLimit("telegram:dm:123", config).toBeUndefined();
  });

  it("prefers account-scoped limits over the channel root for that account", () => {
    const config = telegramConfig({
      historyLimit: 10,
      dmHistoryLimit: 15,
      dms: { "123": { historyLimit: 7 } },
      accounts: {
        work: {
          historyLimit: 40,
          dmHistoryLimit: 41,
          dms: { "123": { historyLimit: 42 } },
        },
        sparse: { historyLimit: 50 },
      },
    });

    const cases: Array<[string, string | undefined, number | undefined]> = [
      ["telegram:channel:c1", "work", 40],
      ["telegram:group:g1", "work", 40],
      ["telegram:dm:999", "work", 41],
      ["telegram:dm:123", "work", 42],
      ["telegram:channel:c1", undefined, 10],
      ["telegram:dm:999", undefined, 15],
      ["telegram:dm:123", undefined, 7],
      ["telegram:dm:999", "sparse", 15],
      ["telegram:dm:123", "sparse", 7],
      ["telegram:channel:c1", "missing-account", 10],
    ];

    for (const [sessionKey, accountId, expected] of cases) {
      expect(
        getHistoryLimitFromSessionKey(sessionKey, config, { accountId }),
        `${sessionKey}/${accountId}`,
      ).toBe(expected);
    }
  });

  it("matches an operator-written account key against the canonical routed id", () => {
    const config = telegramConfig({
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
    });

    for (const accountId of ["work-team", "Work Team", "WORK TEAM"]) {
      expectHistoryLimit("telegram:channel:c1", config, { accountId }).toBe(40);
      expectHistoryLimit("telegram:dm:999", config, { accountId }).toBe(41);
      expectHistoryLimit("telegram:dm:123", config, { accountId }).toBe(42);
    }
    expectHistoryLimit("telegram:channel:c1", config, { accountId: "other" }).toBe(10);
  });

  it("treats an explicit account limit of 0 as a real override", () => {
    const config = {
      channels: {
        slack: {
          historyLimit: 25,
          dmHistoryLimit: 30,
          accounts: { off: { historyLimit: 0, dmHistoryLimit: 0 } },
        },
      },
    } as unknown as OpenClawConfig;

    expectHistoryLimit("slack:channel:c1", config, { accountId: "off" }).toBe(0);
    expectHistoryLimit("slack:dm:u1", config, { accountId: "off" }).toBe(0);
  });
});

describe("account-scoped limits change the retained transcript", () => {
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

  const cfg = telegramConfig({ historyLimit: 20, accounts: { "Work Team": { historyLimit: 2 } } });

  const sessionKey = "agent:main:telegram:channel:c1";
  const messages = transcript(40);

  it("trims to the account limit for that account", () => {
    const limited = limitHistoryTurns(
      messages,
      getHistoryLimitFromSessionKey(sessionKey, cfg, { accountId: "work-team" }),
    );
    expect(countUserTurns(limited)).toBeLessThan(countUserTurns(messages));
    expect(countUserTurns(limited)).toBeLessThanOrEqual(3);
  });

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
