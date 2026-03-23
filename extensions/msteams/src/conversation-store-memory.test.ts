import { describe, expect, it } from "vitest";
import { createMSTeamsConversationStoreMemory } from "./conversation-store-memory.js";

describe("createMSTeamsConversationStoreMemory", () => {
  it("upserts, lists, removes, and resolves users by both AAD and Bot Framework ids", async () => {
    const store = createMSTeamsConversationStoreMemory([
      {
        conversationId: "conv-a",
        reference: {
          conversation: { id: "conv-a" },
          user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
        },
      },
    ]);

    await store.upsert("conv-b", {
      conversation: { id: "conv-b" },
      user: { id: "user-b", aadObjectId: "aad-b", name: "Bob" },
    });

    await expect(store.get("conv-a")).resolves.toEqual({
      conversation: { id: "conv-a" },
      user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
    });

    await expect(store.list()).resolves.toEqual([
      {
        conversationId: "conv-a",
        reference: {
          conversation: { id: "conv-a" },
          user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
        },
      },
      {
        conversationId: "conv-b",
        reference: {
          conversation: { id: "conv-b" },
          user: { id: "user-b", aadObjectId: "aad-b", name: "Bob" },
        },
      },
    ]);

    await expect(store.findByUserId("  aad-b  ")).resolves.toEqual({
      conversationId: "conv-b",
      reference: {
        conversation: { id: "conv-b" },
        user: { id: "user-b", aadObjectId: "aad-b", name: "Bob" },
      },
    });
    await expect(store.findByUserId("user-a")).resolves.toEqual({
      conversationId: "conv-a",
      reference: {
        conversation: { id: "conv-a" },
        user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
      },
    });
    await expect(store.findByUserId("   ")).resolves.toBeNull();

    await expect(store.remove("conv-a")).resolves.toBe(true);
    await expect(store.get("conv-a")).resolves.toBeNull();
    await expect(store.remove("missing")).resolves.toBe(false);
  });
});
