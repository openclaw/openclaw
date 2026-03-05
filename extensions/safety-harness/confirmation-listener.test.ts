import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfirmationListener } from "./confirmation-listener.js";
import { PendingActionStore } from "./pending-actions.js";

describe("ConfirmationListener", () => {
  let tmpDir: string;
  let store: PendingActionStore;
  let listener: ConfirmationListener;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-listener-"));
    store = new PendingActionStore(path.join(tmpDir, "pending.json"));
    listener = new ConfirmationListener(store);
  });

  afterEach(() => {
    store.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts nonce from confirmation reply", () => {
    expect(listener.extractNonce("CONFIRM 123456")).toBe("123456");
    expect(listener.extractNonce("Yes, CONFIRM 123456")).toBe("123456");
    expect(listener.extractNonce("confirm 123456")).toBe("123456");
  });

  it("returns null for non-confirmation messages", () => {
    expect(listener.extractNonce("no thanks")).toBeNull();
    expect(listener.extractNonce("delete the emails")).toBeNull();
  });

  it("verifies nonce against pending action", async () => {
    store.add({
      id: "action-1",
      tool: "email.delete",
      params: { count: 3 },
      nonce: "123456",
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
      status: "pending",
      sessionId: "session-123",
    });

    const result = await listener.handleReply({
      sessionId: "session-123",
      content: "CONFIRM 123456",
      userId: "client-user-id",
    });

    expect(result.approved).toBe(true);
    expect(result.actionId).toBe("action-1");
  });

  it("rejects reply from wrong user", async () => {
    store.add({
      id: "action-1",
      tool: "email.delete",
      params: { count: 3 },
      nonce: "123456",
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
      status: "pending",
      sessionId: "session-123",
      authorizedUserId: "client-user-id",
    });

    const result = await listener.handleReply({
      sessionId: "session-123",
      content: "CONFIRM 123456",
      userId: "wrong-user-id",
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("unauthorized");
  });

  it("rejects expired confirmation", async () => {
    store.add({
      id: "action-1",
      tool: "email.delete",
      params: { count: 3 },
      nonce: "123456",
      createdAt: Date.now() - 400_000,
      expiresAt: Date.now() - 100_000,
      status: "pending",
      sessionId: "session-123",
    });

    const result = await listener.handleReply({
      sessionId: "session-123",
      content: "CONFIRM 123456",
      userId: "client-user-id",
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("expired");
  });

  it("rejects non-matching nonce", async () => {
    store.add({
      id: "action-1",
      tool: "email.delete",
      params: { count: 3 },
      nonce: "123456",
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
      status: "pending",
      sessionId: "session-123",
    });

    const result = await listener.handleReply({
      sessionId: "session-123",
      content: "CONFIRM 999999",
      userId: "client-user-id",
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("no matching");
  });
});
