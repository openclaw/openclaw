import { describe, expect, it } from "vitest";
import { resolveTurnAuthorityAuthorization } from "../plugins/turn-authority.js";
import { createAgentCommandIngressTurnAuthority } from "./agent-command-ingress-authority.js";

describe("createAgentCommandIngressTurnAuthority", () => {
  it("issues sender authority from authenticated direct-ingress facts", () => {
    const authority = createAgentCommandIngressTurnAuthority({
      facts: {
        provider: "discord",
        accountId: "work",
        senderId: "user-1",
        senderName: "Ada",
        senderUsername: "ada",
        roleIds: ["maintainer"],
        isAuthorizedSender: true,
        conversationId: "voice-1",
      },
      agentId: "main",
      sessionKey: "agent:main:discord:voice:voice-1",
      senderIsOwner: false,
    });

    expect(resolveTurnAuthorityAuthorization(authority)).toEqual({
      principal: {
        kind: "sender",
        provider: "discord",
        accountId: "work",
        senderId: "user-1",
        aliases: { name: "ada", username: "ada" },
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainer"],
      },
      agentId: "main",
      sessionKey: "agent:main:discord:voice:voice-1",
      conversationId: "voice-1",
      trigger: "channel",
    });
    expect(authority.controllerKey).toBe("sender:discord:work:user-1");
  });

  it("keeps missing direct-ingress sender identity unknown", () => {
    const authority = createAgentCommandIngressTurnAuthority({
      facts: { provider: "irc", accountId: "default" },
    });

    expect(resolveTurnAuthorityAuthorization(authority)?.principal).toEqual({
      kind: "unknown",
      provider: "irc",
      accountId: "default",
    });
    expect(authority.controllerKey).toBeUndefined();
  });
});
