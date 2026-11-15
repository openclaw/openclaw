import { describe, expect, it } from "vitest";
import type { AgentBindingMatch } from "../config/types.agents.js";
import { resolveRequesterOriginForChild } from "./spawn-requester-origin.js";

type Request = Parameters<typeof resolveRequesterOriginForChild>[0];
const binding = (
  channel: string,
  accountId: string,
  peer?: AgentBindingMatch["peer"],
  scope: Pick<AgentBindingMatch, "guildId" | "roles"> = {},
) => ({
  type: "route" as const,
  agentId: "bot-alpha",
  match: { channel, accountId, ...(peer ? { peer } : {}), ...scope },
});
const peer = (id: string, kind: NonNullable<AgentBindingMatch["peer"]>["kind"] = "channel") => ({
  kind,
  id,
});
const matrixDefault = binding("matrix", "bot-alpha-default");
const matrixRoom = binding("matrix", "bot-alpha-room-a", peer("!roomA:example.org"));
const matrixWildcard = binding("matrix", "bot-alpha-wildcard", peer("*"));
function resolve(
  params: Pick<Request, "cfg" | "requesterChannel" | "requesterTo"> & Partial<Request>,
) {
  return resolveRequesterOriginForChild({
    targetAgentId: "bot-alpha",
    requesterAgentId: "main",
    requesterAccountId: "bot-beta",
    ...params,
  });
}
function expectOrigin(params: Parameters<typeof resolve>[0], accountId: string) {
  const origin = resolve(params);
  expect(origin?.channel).toBe(params.requesterChannel);
  expect(origin?.accountId).toBe(accountId);
  expect(origin?.to).toBe(params.requesterTo);
}

describe("resolveRequesterOriginForChild", () => {
  it.each([
    {
      name: "prefers exact peer binding over wildcard and channel-only bindings",
      requesterTo: "!roomA:example.org",
      expected: "bot-alpha-room-a",
      bindings: [matrixDefault, matrixWildcard, matrixRoom],
    },
    {
      name: "falls back to channel-only binding when peer does not match",
      requesterTo: "!roomB:example.org",
      expected: "bot-alpha-default",
      bindings: [matrixDefault, matrixRoom],
    },
    {
      name: "treats wildcard peer binding as match-any and beats channel-only",
      requesterTo: "!anyRoom:example.org",
      expected: "bot-alpha-wildcard",
      bindings: [matrixDefault, matrixWildcard],
    },
    {
      name: "uses requester roles for role-scoped target-agent accounts",
      requesterChannel: "discord",
      requesterTo: "channel:ops",
      requesterGroupSpace: "guild-current",
      requesterMemberRoleIds: ["admin"],
      expected: "bot-alpha-admin",
      bindings: [
        binding("discord", "bot-alpha-other-guild", peer("channel:ops"), {
          guildId: "guild-other",
        }),
        binding("discord", "bot-alpha-default"),
        binding("discord", "bot-alpha-admin", peer("channel:ops"), {
          guildId: "guild-current",
          roles: ["admin"],
        }),
      ],
    },
    {
      name: "strips channel-side prefixes before bound-account lookup",
      requesterTo: "room:!exampleRoomId:example.org",
      expected: "bot-alpha",
      bindings: [binding("matrix", "bot-alpha", peer("!exampleRoomId:example.org"))],
    },
    {
      name: "classifies Matrix room:@user targets as direct, not channel",
      requesterTo: "room:@other-user:example.org",
      expected: "bot-alpha-dm",
      bindings: [
        binding("matrix", "bot-alpha-wrong-kind", peer("@other-user:example.org")),
        binding("matrix", "bot-alpha-dm", peer("@other-user:example.org", "direct")),
      ],
    },
    {
      name: "preserves the caller account for same-agent subagent spawns",
      requesterAccountId: "bot-alpha-adhoc",
      requesterAgentId: "bot-alpha",
      requesterTo: "!someRoom:example.org",
      expected: "bot-alpha-adhoc",
      bindings: [matrixDefault],
    },
  ])("selects target account: $name", ({ name: _name, bindings, expected, ...request }) => {
    expectOrigin(
      {
        requesterChannel: "matrix",
        ...request,
        cfg: { bindings },
      },
      expected,
    );
  });

  it.each([
    ["channel:conversation-a", "qa-channel", "channel", "channel:conversation-a"],
    ["dm:conversation-a", "qa-channel", "direct", "dm:conversation-a"],
    ["thread:conversation-a/thread-a", "qa-channel", "channel", "thread:conversation-a/thread-a"],
    ["conversation:a:1:team-thread", "msteams", "channel", "a:1:team-thread"],
    ["channel:@ops", "qa-channel", "channel", "channel:@ops"],
    ["line:group:U123example", "line", "group", "U123example"],
  ] as const)("resolves wrapped or canonical %s as %s/%s peer %s", (to, channel, kind, peerId) => {
    expectOrigin(
      {
        cfg: { bindings: [binding(channel, "bot-alpha", peer(peerId, kind))] },
        requesterChannel: channel,
        requesterTo: to,
      },
      "bot-alpha",
    );
  });
});
