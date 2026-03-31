import { describe, expect, it, beforeEach } from "vitest";
import {
  registerPendingCardUpdate,
  getPendingCardUpdate,
  completeCardUpdate,
  resetCardUpdateRegistryForTests,
} from "./card-update.js";

describe("card update registry", () => {
  beforeEach(() => {
    resetCardUpdateRegistryForTests();
  });

  it("registers and retrieves a pending card update", () => {
    const updateId = registerPendingCardUpdate({
      accountId: "test-account",
      messageId: "msg_123",
      chatId: "chat_abc",
      originalEnvelope: { oc: "ocf1", k: "update", a: "test" },
    });

    expect(updateId).toBeTruthy();

    const pending = getPendingCardUpdate(updateId);
    expect(pending).toEqual(
      expect.objectContaining({
        accountId: "test-account",
        messageId: "msg_123",
        chatId: "chat_abc",
      }),
    );
  });

  it("returns null for unknown update id", () => {
    const pending = getPendingCardUpdate("unknown-id");
    expect(pending).toBeNull();
  });

  it("marks update as completed", () => {
    const updateId = registerPendingCardUpdate({
      accountId: "test-account",
      messageId: "msg_123",
      chatId: "chat_abc",
      originalEnvelope: { oc: "ocf1", k: "update", a: "test" },
    });

    completeCardUpdate(updateId);

    const pending = getPendingCardUpdate(updateId);
    expect(pending).toBeNull();
  });

  it("prunes expired entries", () => {
    const updateId = registerPendingCardUpdate(
      {
        accountId: "test-account",
        messageId: "msg_123",
        chatId: "chat_abc",
        originalEnvelope: { oc: "ocf1", k: "update", a: "test" },
      },
      Date.now() - 16 * 60 * 1000, // expired 16 minutes ago (TTL is 15 min)
    );

    const pending = getPendingCardUpdate(updateId, Date.now());
    expect(pending).toBeNull();
  });
});
