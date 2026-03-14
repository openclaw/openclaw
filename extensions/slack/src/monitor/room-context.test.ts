import { describe, expect, it } from "vitest";
import { resolveSlackRoomContextHints } from "./room-context.js";

describe("resolveSlackRoomContextHints", () => {
  it("always includes platform prompt for channel messages", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: true,
      isDirectMessage: false,
    });
    expect(result.groupSystemPrompt).toContain("*Slack Formatting Rules*");
  });

  it("always includes platform prompt for DMs", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: false,
      isDirectMessage: true,
    });
    expect(result.groupSystemPrompt).toContain("*Slack Formatting Rules*");
  });

  it("stacks global + channel systemPrompt for channels", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: true,
      isDirectMessage: false,
      globalSystemPrompt: "You are a bot.",
      channelConfig: { systemPrompt: "Focus on engineering." },
    });
    expect(result.groupSystemPrompt).toContain("*Slack Formatting Rules*");
    expect(result.groupSystemPrompt).toContain("You are a bot.");
    expect(result.groupSystemPrompt).toContain("Focus on engineering.");
  });

  it("stacks global + DM systemPrompt for DMs", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: false,
      isDirectMessage: true,
      globalSystemPrompt: "You are a bot.",
      dmSystemPrompt: "Be concise.",
    });
    expect(result.groupSystemPrompt).toContain("You are a bot.");
    expect(result.groupSystemPrompt).toContain("Be concise.");
  });

  it("does not include DM prompt in channels", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: true,
      isDirectMessage: false,
      dmSystemPrompt: "DM only prompt",
      channelConfig: { systemPrompt: "Channel prompt" },
    });
    expect(result.groupSystemPrompt).toContain("Channel prompt");
    expect(result.groupSystemPrompt).not.toContain("DM only prompt");
  });

  it("does not include channel prompt in DMs", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: false,
      isDirectMessage: true,
      channelConfig: { systemPrompt: "Channel prompt" },
      dmSystemPrompt: "DM prompt",
    });
    expect(result.groupSystemPrompt).toContain("DM prompt");
    expect(result.groupSystemPrompt).not.toContain("Channel prompt");
  });

  it("returns untrustedChannelMetadata only for roomish", () => {
    const roomResult = resolveSlackRoomContextHints({
      isRoomish: true,
      isDirectMessage: false,
      channelInfo: { topic: "test topic", purpose: "test purpose" },
    });
    expect(roomResult.untrustedChannelMetadata).toBeDefined();

    const dmResult = resolveSlackRoomContextHints({
      isRoomish: false,
      isDirectMessage: true,
      channelInfo: { topic: "test topic", purpose: "test purpose" },
    });
    expect(dmResult.untrustedChannelMetadata).toBeUndefined();
  });

  it("trims whitespace from system prompts", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: false,
      isDirectMessage: true,
      globalSystemPrompt: "  padded  ",
    });
    expect(result.groupSystemPrompt).toContain("padded");
    expect(result.groupSystemPrompt).not.toContain("  padded  ");
  });

  it("skips empty/null system prompts", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: true,
      isDirectMessage: false,
      globalSystemPrompt: "  ",
      channelConfig: { systemPrompt: null },
    });
    // Should only contain platform prompt, no extra newlines from empty parts
    expect(result.groupSystemPrompt).not.toMatch(/\n\n$/);
  });
});
