import { describe, expect, it, vi } from "vitest";
import {
  evaluateMattermostMentionGate,
  mapMattermostChannelTypeToChatType,
  resolveMattermostChannelType,
  resolveMattermostTrustedChatKind,
} from "./monitor-gating.js";

describe("mattermost monitor gating", () => {
  it("maps mattermost channel types to chat types", () => {
    expect(mapMattermostChannelTypeToChatType("D")).toBe("direct");
    expect(mapMattermostChannelTypeToChatType("G")).toBe("group");
    expect(mapMattermostChannelTypeToChatType("P")).toBe("group");
    expect(mapMattermostChannelTypeToChatType("O")).toBe("channel");
    expect(mapMattermostChannelTypeToChatType("x")).toBe("channel");
  });

  it("rejects missing channel types instead of defaulting to channel", () => {
    expect(() => mapMattermostChannelTypeToChatType(undefined)).toThrow(
      "Mattermost channel type is required",
    );
    expect(() => mapMattermostChannelTypeToChatType(null)).toThrow(
      "Mattermost channel type is required",
    );
    expect(() => mapMattermostChannelTypeToChatType(" ")).toThrow(
      "Mattermost channel type is required",
    );
  });

  it("selects the first available resolved channel type", () => {
    expect(resolveMattermostChannelType(undefined, "", " D ")).toBe("D");
    expect(resolveMattermostChannelType(null, "  ")).toBeNull();
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
    expect(() => resolveMattermostTrustedChatKind({})).toThrow(
      "Mattermost channel type is required",
    );
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
    ).toMatchObject({
      shouldRequireMention: false,
      dropReason: null,
    });
  });
});
