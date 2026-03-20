import { describe, expect, it } from "vitest";
import {
  buildDiscordGroupSystemPrompt,
  buildDiscordInboundAccessContext,
  buildDiscordUntrustedContext,
} from "./inbound-context.js";

describe("Discord inbound context helpers", () => {
  it("builds guild access context from channel config and topic", () => {
    expect(
      buildDiscordInboundAccessContext({
        channelConfig: {
          allowed: true,
          users: ["discord:user-1"],
          systemPrompt: "Use the runbook.",
        },
        guildInfo: { id: "guild-1" },
        sender: {
          id: "user-1",
          name: "tester",
          tag: "tester#0001",
        },
        isGuild: true,
        channelTopic: "Production alerts only",
      }),
    ).toEqual({
      groupSystemPrompt: "Use the runbook.",
      untrustedContext: [expect.stringContaining("Production alerts only")],
      ownerAllowFrom: ["user-1"],
    });
  });

  it("omits guild-only metadata for direct messages", () => {
    expect(
      buildDiscordInboundAccessContext({
        sender: {
          id: "user-1",
        },
        isGuild: false,
        channelTopic: "ignored",
      }),
    ).toEqual({
      groupSystemPrompt: undefined,
      untrustedContext: undefined,
      ownerAllowFrom: undefined,
    });
  });

  it("keeps direct helper behavior consistent", () => {
    expect(buildDiscordGroupSystemPrompt({ allowed: true, systemPrompt: "  hi  " })).toBe("hi");
    expect(buildDiscordUntrustedContext({ isGuild: true, channelTopic: "topic" })).toEqual([
      expect.stringContaining("topic"),
    ]);
  });
});
