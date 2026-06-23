// Mattermost tests cover monitor gating plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { MattermostPost } from "./client.js";
import {
  evaluateMattermostMentionGate,
  mapMattermostChannelTypeToChatType,
  resolveMattermostReplyToBot,
  resolveMattermostTrustedChatKind,
} from "./monitor-gating.js";

describe("mattermost monitor gating", () => {
  it("maps mattermost channel types to chat types", () => {
    expect(mapMattermostChannelTypeToChatType("D")).toBe("direct");
    expect(mapMattermostChannelTypeToChatType("G")).toBe("group");
    expect(mapMattermostChannelTypeToChatType("P")).toBe("group");
    expect(mapMattermostChannelTypeToChatType("O")).toBe("channel");
    expect(mapMattermostChannelTypeToChatType(undefined)).toBe("direct");
    expect(mapMattermostChannelTypeToChatType(null)).toBe("direct");
    expect(mapMattermostChannelTypeToChatType("")).toBe("direct");
  });

  it("derives chat kind from trusted channel lookup before fallback state", () => {
    expect(
      resolveMattermostTrustedChatKind({
        channelType: "O",
        fallback: "direct",
      }),
    ).toBe("channel");
    expect(
      resolveMattermostTrustedChatKind({
        channelType: "D",
        fallback: "channel",
      }),
    ).toBe("direct");
    expect(resolveMattermostTrustedChatKind({ fallback: "group" })).toBe("group");
    expect(resolveMattermostTrustedChatKind({})).toBe("direct");
  });

  it("drops non-mentioned traffic when onchar is enabled but not triggered", () => {
    const resolveRequireMention = vi.fn(() => true);

    expect(
      evaluateMattermostMentionGate({
        kind: "channel",
        cfg: {} as never,
        accountId: "default",
        channelId: "chan-1",
        resolveRequireMention,
        wasMentioned: false,
        isControlCommand: false,
        commandAuthorized: false,
        oncharEnabled: true,
        oncharTriggered: false,
        canDetectMention: true,
      }),
    ).toEqual({
      shouldRequireMention: true,
      shouldBypassMention: false,
      effectiveWasMentioned: false,
      dropReason: "onchar-not-triggered",
    });
  });

  it("bypasses mention for authorized control commands and allows direct chats", () => {
    const resolveRequireMention = vi.fn(() => true);

    expect(
      evaluateMattermostMentionGate({
        kind: "channel",
        cfg: {} as never,
        accountId: "default",
        channelId: "chan-1",
        resolveRequireMention,
        wasMentioned: false,
        isControlCommand: true,
        commandAuthorized: true,
        oncharEnabled: false,
        oncharTriggered: false,
        canDetectMention: true,
      }),
    ).toEqual({
      shouldRequireMention: true,
      shouldBypassMention: true,
      effectiveWasMentioned: true,
      dropReason: null,
    });

    expect(
      evaluateMattermostMentionGate({
        kind: "direct",
        cfg: {} as never,
        accountId: "default",
        channelId: "chan-1",
        resolveRequireMention,
        wasMentioned: false,
        isControlCommand: false,
        commandAuthorized: false,
        oncharEnabled: false,
        oncharTriggered: false,
        canDetectMention: true,
      }),
    ).toEqual({
      shouldRequireMention: false,
      shouldBypassMention: false,
      effectiveWasMentioned: false,
      dropReason: null,
    });
  });

  it("treats a reply to the bot as a mention even when requireMention is set", () => {
    const resolveRequireMention = vi.fn(() => true);
    const base = {
      kind: "channel" as const,
      cfg: {} as never,
      accountId: "default",
      channelId: "chan-1",
      resolveRequireMention,
      wasMentioned: false,
      isControlCommand: false,
      commandAuthorized: false,
      oncharEnabled: false,
      oncharTriggered: false,
      canDetectMention: true,
    };

    expect(evaluateMattermostMentionGate({ ...base, replyToBot: true })).toEqual({
      shouldRequireMention: true,
      shouldBypassMention: false,
      effectiveWasMentioned: true,
      dropReason: null,
    });

    expect(evaluateMattermostMentionGate({ ...base, replyToBot: false })).toEqual({
      shouldRequireMention: true,
      shouldBypassMention: false,
      effectiveWasMentioned: false,
      dropReason: "missing-mention",
    });
  });

  it("lets a reply to the bot bypass the onchar trigger requirement", () => {
    const resolveRequireMention = vi.fn(() => true);

    expect(
      evaluateMattermostMentionGate({
        kind: "channel",
        cfg: {} as never,
        accountId: "default",
        channelId: "chan-1",
        resolveRequireMention,
        wasMentioned: false,
        isControlCommand: false,
        commandAuthorized: false,
        oncharEnabled: true,
        oncharTriggered: false,
        canDetectMention: true,
        replyToBot: true,
      }),
    ).toEqual({
      shouldRequireMention: true,
      shouldBypassMention: false,
      effectiveWasMentioned: true,
      dropReason: null,
    });
  });
});

describe("resolveMattermostReplyToBot", () => {
  const post = (overrides: Partial<MattermostPost>): MattermostPost =>
    ({ id: "root-1", ...overrides }) as MattermostPost;

  it("returns false without a thread root and never fetches", async () => {
    const fetchRootPost = vi.fn();

    expect(
      await resolveMattermostReplyToBot({
        threadRootId: undefined,
        botUserId: "bot-1",
        fetchRootPost,
      }),
    ).toBe(false);
    expect(
      await resolveMattermostReplyToBot({ threadRootId: "  ", botUserId: "bot-1", fetchRootPost }),
    ).toBe(false);
    expect(fetchRootPost).not.toHaveBeenCalled();
  });

  it("detects a thread root authored by the bot", async () => {
    const fetchRootPost = vi.fn(async () => post({ id: "root-1", user_id: "bot-1" }));

    expect(
      await resolveMattermostReplyToBot({
        threadRootId: "root-1",
        botUserId: "bot-1",
        fetchRootPost,
      }),
    ).toBe(true);
    expect(fetchRootPost).toHaveBeenCalledWith("root-1");
  });

  it("returns false when the thread root was authored by someone else", async () => {
    const fetchRootPost = vi.fn(async () => post({ id: "root-1", user_id: "user-9" }));

    expect(
      await resolveMattermostReplyToBot({
        threadRootId: "root-1",
        botUserId: "bot-1",
        fetchRootPost,
      }),
    ).toBe(false);
  });

  it("returns false when the root post cannot be fetched", async () => {
    const fetchRootPost = vi.fn(async () => null);

    expect(
      await resolveMattermostReplyToBot({
        threadRootId: "root-1",
        botUserId: "bot-1",
        fetchRootPost,
      }),
    ).toBe(false);
  });
});
