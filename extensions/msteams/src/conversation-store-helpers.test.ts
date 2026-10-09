import { describe, expect, it } from "vitest";
import { findPreferredDmConversationByUserId } from "./conversation-store-helpers.js";
import type { MSTeamsConversationStoreEntry } from "./conversation-store.js";

function entry(params: {
  conversationId: string;
  aadObjectId?: string;
  conversationType?: string;
  lastSeenAt?: string;
}): MSTeamsConversationStoreEntry {
  return {
    conversationId: params.conversationId,
    reference: {
      user: {
        id: "user-1",
        aadObjectId: params.aadObjectId ?? "aad-1",
      },
      conversation: {
        id: params.conversationId,
        conversationType: params.conversationType,
      },
      lastSeenAt: params.lastSeenAt,
    },
  };
}

describe("findPreferredDmConversationByUserId", () => {
  it("returns null when no entries match", () => {
    const entries = [entry({ conversationId: "conv-1", aadObjectId: "other-user" })];
    expect(findPreferredDmConversationByUserId(entries, "aad-1")).toBeNull();
  });

  it("prefers personal DM over channel even when channel is more recent (#54520)", () => {
    // A later channel activity must not redirect a DM (#54520).
    const entries = [
      entry({
        conversationId: "dm-conv",
        aadObjectId: "aad-target",
        conversationType: "personal",
        lastSeenAt: "2026-03-25T20:00:00.000Z",
      }),
      entry({
        conversationId: "19:channel@thread.tacv2",
        aadObjectId: "aad-target",
        conversationType: "channel",
        lastSeenAt: "2026-03-25T21:00:00.000Z",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result?.conversationId).toBe("dm-conv");
  });

  it("falls back to unknown-type entries when no personal conversations exist", () => {
    const entries = [
      entry({
        conversationId: "legacy-conv",
        aadObjectId: "aad-target",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result?.conversationId).toBe("legacy-conv");
  });

  it("prefers personal over unknown-type entries", () => {
    const entries = [
      entry({
        conversationId: "legacy-conv",
        aadObjectId: "aad-target",
        lastSeenAt: "2026-03-25T21:00:00.000Z",
      }),
      entry({
        conversationId: "dm-conv",
        aadObjectId: "aad-target",
        conversationType: "personal",
        lastSeenAt: "2026-03-25T20:00:00.000Z",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result?.conversationId).toBe("dm-conv");
  });

  it("does NOT fall back to channel/group when no personal or unknown entries exist", () => {
    const entries = [
      entry({
        conversationId: "19:channel@thread.tacv2",
        aadObjectId: "aad-target",
        conversationType: "channel",
        lastSeenAt: "2026-03-25T21:00:00.000Z",
      }),
      entry({
        conversationId: "19:group@thread.tacv2",
        aadObjectId: "aad-target",
        conversationType: "groupChat",
        lastSeenAt: "2026-03-25T20:00:00.000Z",
      }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result).toBeNull();
  });
});
