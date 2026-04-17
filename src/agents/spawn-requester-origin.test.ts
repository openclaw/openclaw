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
});
