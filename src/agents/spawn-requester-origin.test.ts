import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequesterOriginForChild } from "./spawn-requester-origin.js";

describe("resolveRequesterOriginForChild", () => {
  it("keeps canonical prefixed peer ids eligible for exact binding lookup", () => {
    const cfg = {
      bindings: [
        {
          type: "route",
          agentId: "bot-alpha",
          match: {
            channel: "qa-channel",
            peer: {
              kind: "channel",
              id: "channel:conversation-a",
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
        requesterTo: "channel:conversation-a",
      }),
    ).toMatchObject({
      channel: "qa-channel",
      accountId: "bot-alpha-qa",
      to: "channel:conversation-a",
    });
  });
});
