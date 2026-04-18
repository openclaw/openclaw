import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequesterOriginForChild } from "./spawn-requester-origin.js";

describe("resolveRequesterOriginForChild", () => {
  it.each([
    ["channel:conversation-a", "channel:conversation-a", "channel"],
    ["dm:conversation-a", "dm:conversation-a", "direct"],
    ["thread:conversation-a/thread-a", "thread:conversation-a/thread-a", "channel"],
  ] as const)(
    "keeps canonical prefixed peer id %s eligible for exact binding lookup",
    (to, peerId, peerKind) => {
      const cfg = {
        bindings: [
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "qa-channel",
              peer: {
                kind: peerKind,
                id: peerId,
              },
              accountId: "bot-alpha-qa",
            },
          },
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
        accountId: "bot-alpha-qa",
        to,
      });
    },
  );

  it("preserves canonical peer ids that start with token-colon after a known wrapper", () => {
    const to = "conversation:a:1:team-thread";
    const cfg = {
      bindings: [
        {
          type: "route",
          agentId: "bot-alpha",
          match: {
            channel: "msteams",
            peer: {
              kind: "channel",
              id: "a:1:team-thread",
            },
            accountId: "bot-alpha-teams",
          },
        },
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
      accountId: "bot-alpha-teams",
      to,
    });
  });

  it("keeps plugin-inferred channel kind for ids that start with direct marker characters", () => {
    const to = "channel:@ops";
    const cfg = {
      bindings: [
        {
          type: "route",
          agentId: "bot-alpha",
          match: {
            channel: "qa-channel",
            peer: {
              kind: "channel",
              id: to,
            },
            accountId: "bot-alpha-qa",
          },
        },
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
      accountId: "bot-alpha-qa",
      to,
    });
  });

  it("uses requester group space before selecting a scoped target-agent account", () => {
    const to = "channel:ops";
    const cfg = {
      bindings: [
        {
          type: "route",
          agentId: "bot-alpha",
          match: {
            channel: "discord",
            guildId: "guild-other",
            peer: {
              kind: "channel",
              id: to,
            },
            accountId: "bot-alpha-other-guild",
          },
        },
        {
          type: "route",
          agentId: "bot-alpha",
          match: {
            channel: "discord",
            guildId: "guild-current",
            peer: {
              kind: "channel",
              id: to,
            },
            accountId: "bot-alpha-current-guild",
          },
        },
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
      accountId: "bot-alpha-current-guild",
      to,
    });
  });

  it("still peels channel id plus kind wrappers before peer lookup", () => {
    const to = "line:group:U123example";
    const cfg = {
      bindings: [
        {
          type: "route",
          agentId: "bot-alpha",
          match: {
            channel: "line",
            peer: {
              kind: "group",
              id: "U123example",
            },
            accountId: "bot-alpha-line",
          },
        },
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
      accountId: "bot-alpha-line",
      to,
    });
  });
});
