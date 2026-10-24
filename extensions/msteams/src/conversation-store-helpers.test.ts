import { describe, expect, it } from "vitest";
import { findPreferredDmConversationByUserId } from "./conversation-store-helpers.js";
import type { MSTeamsConversationStoreEntry } from "./conversation-store.js";

const older = "2026-03-25T20:00:00.000Z";
const newer = "2026-03-25T21:00:00.000Z";

function entry(
  conversationId: string,
  params: {
    aadObjectId?: string;
    conversationType?: string;
    lastSeenAt?: string;
  } = {},
): MSTeamsConversationStoreEntry {
  return {
    conversationId,
    reference: {
      user: { id: "user-1", aadObjectId: params.aadObjectId ?? "aad-target" },
      conversation: { id: conversationId, conversationType: params.conversationType },
      lastSeenAt: params.lastSeenAt,
    },
  };
}

describe("findPreferredDmConversationByUserId", () => {
  it("returns null when no entries match", () => {
    const entries = [entry("conv-1", { aadObjectId: "other-user" })];
    expect(findPreferredDmConversationByUserId(entries, "aad-1")).toBeNull();
  });

  it("prefers personal DM over channel even when channel is more recent (#54520)", () => {
    const entries = [
      entry("dm-conv", { conversationType: "personal", lastSeenAt: older }),
      entry("19:channel@thread.tacv2", { conversationType: "channel", lastSeenAt: newer }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result?.conversationId).toBe("dm-conv");
  });

  it("falls back to unknown-type entries when no personal conversations exist", () => {
    const entries = [entry("legacy-conv")];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result?.conversationId).toBe("legacy-conv");
  });

  it("prefers personal over unknown-type entries", () => {
    const entries = [
      entry("legacy-conv", { lastSeenAt: newer }),
      entry("dm-conv", { conversationType: "personal", lastSeenAt: older }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result?.conversationId).toBe("dm-conv");
  });

  it("does NOT fall back to channel/group when no personal or unknown entries exist", () => {
    const entries = [
      entry("19:channel@thread.tacv2", { conversationType: "channel", lastSeenAt: newer }),
      entry("19:group@thread.tacv2", { conversationType: "groupChat", lastSeenAt: older }),
    ];
    const result = findPreferredDmConversationByUserId(entries, "aad-target");
    expect(result).toBeNull();
  });
});
