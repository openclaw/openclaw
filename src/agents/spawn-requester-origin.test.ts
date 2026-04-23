import { describe, expect, it } from "vitest";
import type { AgentBindingMatch } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequesterOriginForChild } from "./spawn-requester-origin.js";

describe("resolveRequesterOriginForChild", () => {
  function routeBinding(match: AgentBindingMatch) {
    return { type: "route" as const, agentId: "bot-alpha", match };
  }

  function resolveAccount(params: {
    cfg: OpenClawConfig;
    targetAgentId?: string;
    requesterAgentId?: string;
    requesterChannel: string;
    requesterAccountId?: string;
    requesterTo: string;
    requesterGroupSpace?: string | null;
    requesterMemberRoleIds?: string[];
  }) {
    return resolveRequesterOriginForChild({
      requesterAccountId: "bot-beta",
      ...params,
      targetAgentId: params.targetAgentId ?? "bot-alpha",
      requesterAgentId: params.requesterAgentId ?? "main",
    })?.accountId;
  }

  // Cross-agent spawns (requesterAgentId !== targetAgentId): parent accountId is preserved.
  // Only same-agent spawns (requesterAgentId === targetAgentId) use binding resolution.
  it.each([
    ["channel:conversation-a", "channel:conversation-a", "channel"],
    ["dm:conversation-a", "dm:conversation-a", "direct"],
    ["thread:conversation-a/thread-a", "thread:conversation-a/thread-a", "channel"],
  ] as const)(
    "cross-agent: preserves parent accountId for peer id %s (does not use child binding)",
    (to, peerId, peerKind) => {
      const cfg = {
        bindings: [
          routeBinding({
            channel: "qa-channel",
            peer: {
              kind: peerKind,
              id: peerId,
            },
            accountId: "bot-alpha-qa",
          }),
        ],
      } as OpenClawConfig;

      expect(
        resolveRequesterOriginForChild({
          cfg,
          targetAgentId: "bot-alpha",
          requesterAgentId: "main",
          requesterChannel: "qa-channel",
          requesterAccountId: "bot-beta",
          requesterTo: to,
        }),
      ).toMatchObject({
        channel: "qa-channel",
        accountId: "bot-beta", // Parent's accountId, NOT child's binding
        to,
      });
    },
  );

  it.each([
    {
      name: "cross-agent: does not use peer-specific binding",
      requesterChannel: "matrix",
      requesterTo: "!roomA:example.org",
      expected: "bot-beta", // Parent's accountId preserved
      bindings: [
        routeBinding({ channel: "matrix", accountId: "bot-alpha-default" }),
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "!roomA:example.org" },
          accountId: "bot-alpha-room-a",
        }),
      ],
    },
    {
      name: "cross-agent: does not fall back to channel-only binding",
      requesterChannel: "matrix",
      requesterTo: "!roomB:example.org",
      expected: "bot-beta", // Parent's accountId preserved
      bindings: [
        routeBinding({ channel: "matrix", accountId: "bot-alpha-default" }),
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "!roomA:example.org" },
          accountId: "bot-alpha-room-a",
        }),
      ],
    },
    {
      name: "cross-agent: does not use wildcard peer binding",
      requesterChannel: "matrix",
      requesterTo: "!anyRoom:example.org",
      expected: "bot-beta", // Parent's accountId preserved
      bindings: [
        routeBinding({ channel: "matrix", accountId: "bot-alpha-default" }),
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-wildcard",
        }),
      ],
    },
    {
      name: "cross-agent: does not prefer exact peer binding over wildcard",
      requesterChannel: "matrix",
      requesterTo: "!roomA:example.org",
      expected: "bot-beta", // Parent's accountId preserved
      bindings: [
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-wildcard",
        }),
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "!roomA:example.org" },
          accountId: "bot-alpha-room-a",
        }),
      ],
    },
    {
      name: "cross-agent: does not use requester roles for target-agent accounts",
      requesterChannel: "discord",
      requesterTo: "channel:ops",
      requesterGroupSpace: "guild-current",
      requesterMemberRoleIds: ["admin"],
      expected: "bot-beta", // Parent's accountId preserved
      bindings: [
        routeBinding({ channel: "discord", accountId: "bot-alpha-default" }),
        routeBinding({
          channel: "discord",
          guildId: "guild-current",
          roles: ["admin"],
          peer: { kind: "channel", id: "channel:ops" },
          accountId: "bot-alpha-admin",
        }),
      ],
    },
    {
      name: "cross-agent: does not strip channel-side prefixes for binding lookup",
      requesterChannel: "matrix",
      requesterTo: "room:!exampleRoomId:example.org",
      expected: "bot-beta", // Parent's accountId preserved
      bindings: [
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "!exampleRoomId:example.org" },
          accountId: "bot-alpha",
        }),
      ],
    },
    {
      name: "cross-agent: does not classify Matrix room targets by peer kind",
      requesterChannel: "matrix",
      requesterTo: "room:@other-user:example.org",
      expected: "bot-beta", // Parent's accountId preserved
      bindings: [
        routeBinding({
          channel: "matrix",
          peer: { kind: "channel", id: "@other-user:example.org" },
          accountId: "bot-alpha-wrong-kind",
        }),
        routeBinding({
          channel: "matrix",
          peer: { kind: "direct", id: "@other-user:example.org" },
          accountId: "bot-alpha-dm",
        }),
      ],
    },
    {
      name: "same-agent spawn: uses binding when agents match",
      requesterChannel: "matrix",
      requesterAccountId: "bot-alpha-adhoc",
      requesterAgentId: "bot-alpha", // SAME as targetAgentId
      requesterTo: "!someRoom:example.org",
      expected: "bot-alpha-adhoc", // Binding doesn't match channel, falls back to requester accountId
      bindings: [routeBinding({ channel: "matrix", accountId: "bot-alpha-default" })],
    },
  ] as const)("account resolution: $name", (scenario) => {
    expect(
      resolveAccount({
        cfg: { bindings: [...scenario.bindings] } as OpenClawConfig,
        requesterChannel: scenario.requesterChannel,
        requesterAccountId: scenario.requesterAccountId,
        requesterAgentId: scenario.requesterAgentId,
        requesterTo: scenario.requesterTo,
        requesterGroupSpace: scenario.requesterGroupSpace,
        requesterMemberRoleIds: scenario.requesterMemberRoleIds
          ? [...scenario.requesterMemberRoleIds]
          : undefined,
      }),
    ).toBe(scenario.expected);
  });

  it("cross-agent: preserves parent accountId for canonical peer ids with token-colon", () => {
    const to = "conversation:a:1:team-thread";
    const cfg = {
      bindings: [
        routeBinding({
          channel: "msteams",
          peer: {
            kind: "channel",
            id: "a:1:team-thread",
          },
          accountId: "bot-alpha-teams",
        }),
      ],
    } as OpenClawConfig;

    expect(
      resolveRequesterOriginForChild({
        cfg,
        targetAgentId: "bot-alpha",
        requesterAgentId: "main",
        requesterChannel: "msteams",
        requesterAccountId: "bot-beta",
        requesterTo: to,
      }),
    ).toMatchObject({
      channel: "msteams",
      accountId: "bot-beta", // Parent's accountId, NOT child's binding
      to,
    });
  });

  it("cross-agent: preserves parent accountId regardless of explicit channel prefixes", () => {
    const to = "channel:@ops";
    const cfg = {
      bindings: [
        routeBinding({
          channel: "qa-channel",
          peer: {
            kind: "channel",
            id: to,
          },
          accountId: "bot-alpha-qa",
        }),
      ],
    } as OpenClawConfig;

    expect(
      resolveRequesterOriginForChild({
        cfg,
        targetAgentId: "bot-alpha",
        requesterAgentId: "main",
        requesterChannel: "qa-channel",
        requesterAccountId: "bot-beta",
        requesterTo: to,
      }),
    ).toMatchObject({
      channel: "qa-channel",
      accountId: "bot-beta", // Parent's accountId, NOT child's binding
      to,
    });
  });

  it("cross-agent: preserves parent accountId even with guild-scoped bindings", () => {
    const to = "channel:ops";
    const cfg = {
      bindings: [
        routeBinding({
          channel: "discord",
          guildId: "guild-other",
          peer: {
            kind: "channel",
            id: to,
          },
          accountId: "bot-alpha-other-guild",
        }),
        routeBinding({
          channel: "discord",
          guildId: "guild-current",
          peer: {
            kind: "channel",
            id: to,
          },
          accountId: "bot-alpha-current-guild",
        }),
      ],
    } as OpenClawConfig;

    expect(
      resolveRequesterOriginForChild({
        cfg,
        targetAgentId: "bot-alpha",
        requesterAgentId: "main",
        requesterChannel: "discord",
        requesterAccountId: "main-current-guild",
        requesterTo: to,
        requesterGroupSpace: "guild-current",
      }),
    ).toMatchObject({
      channel: "discord",
      accountId: "main-current-guild", // Parent's accountId, NOT child's binding
      to,
    });
  });

  it("cross-agent: preserves parent accountId after peeling channel wrappers", () => {
    const to = "line:group:U123example";
    const cfg = {
      bindings: [
        routeBinding({
          channel: "line",
          peer: {
            kind: "group",
            id: "U123example",
          },
          accountId: "bot-alpha-line",
        }),
      ],
    } as OpenClawConfig;

    expect(
      resolveRequesterOriginForChild({
        cfg,
        targetAgentId: "bot-alpha",
        requesterAgentId: "main",
        requesterChannel: "line",
        requesterAccountId: "bot-beta",
        requesterTo: to,
      }),
    ).toMatchObject({
      channel: "line",
      accountId: "bot-beta", // Parent's accountId, NOT child's binding
      to,
    });
  });
});
