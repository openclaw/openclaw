import { describe, expect, it } from "vitest";
import { buildSynologyChatInboundSessionKey } from "./session-key.js";

describe("buildSynologyChatInboundSessionKey", () => {
  it("isolates direct-message sessions by account and user", () => {
    const alpha = buildSynologyChatInboundSessionKey({
      agentId: "main",
      accountId: "alpha",
      userId: "123",
    });
    const beta = buildSynologyChatInboundSessionKey({
      agentId: "main",
      accountId: "beta",
      userId: "123",
    });
    const otherUser = buildSynologyChatInboundSessionKey({
      agentId: "main",
      accountId: "alpha",
      userId: "456",
    });

    expect(alpha).toBe("agent:main:synology-chat:alpha:direct:123");
    expect(beta).toBe("agent:main:synology-chat:beta:direct:123");
    expect(otherUser).toBe("agent:main:synology-chat:alpha:direct:456");
    expect(alpha).not.toBe(beta);
    expect(alpha).not.toBe(otherUser);
  });
});
