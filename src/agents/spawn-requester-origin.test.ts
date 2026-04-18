import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequesterOriginForChild } from "./spawn-requester-origin.js";

describe("resolveRequesterOriginForChild", () => {
  it.each([
    ["channel:conversation-a", "channel:conversation-a"],
    ["thread:conversation-a/thread-a", "thread:conversation-a/thread-a"],
  ])("keeps canonical prefixed peer id %s eligible for exact binding lookup", (to, peerId) => {
    const cfg = {
      bindings: [
        {
          type: "route",
          agentId: "bot-alpha",
          match: {
            channel: "qa-channel",
            peer: {
              kind: "channel",
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
  });

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
