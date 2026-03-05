import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PendingAction, PendingActionStore } from "./pending-actions.js";

describe("PendingActionStore", () => {
  let store: PendingActionStore;

  beforeEach(() => {
    store = new PendingActionStore();
  });

  afterEach(() => {
    store.clear();
  });

  it("adds and retrieves a pending action", () => {
    const action: PendingAction = {
      id: "action-1",
      tool: "email.delete",
      params: { count: 3 },
      nonce: "123456",
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
      status: "pending",
    };
    store.add(action);
    expect(store.get(action.id)).toEqual(action);
  });

  it("removes action on approved", () => {
    const action: PendingAction = {
      id: "action-1",
      tool: "email.delete",
      params: { count: 3 },
      nonce: "123456",
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    };
    store.add(action);
    store.remove(action.id);
    expect(store.get(action.id)).toBeUndefined();
  });

  it("removes action on denied", () => {
    const action: PendingAction = {
      id: "action-2",
      tool: "email.send",
      params: { to: "test@example.com" },
      nonce: "654321",
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    };
    store.add(action);
    store.remove(action.id);
    expect(store.get(action.id)).toBeUndefined();
  });

  it("returns expired actions", () => {
    const action: PendingAction = {
      id: "action-1",
      tool: "email.delete",
      params: { count: 3 },
      nonce: "123456",
      createdAt: Date.now() - 400_000,
      expiresAt: Date.now() - 100_000,
    };
    store.add(action);
    const expired = store.getExpired();
    expect(expired).toHaveLength(1);
  });

  it("lists pending actions by tool", () => {
    store.add({
      id: "action-1",
      tool: "email.delete",
      params: { count: 3 },
      nonce: "123456",
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    });
    store.add({
      id: "action-2",
      tool: "email.send",
      params: { to: "test@example.com" },
      nonce: "654321",
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    });
    const deletes = store.listByTool("email.delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].tool).toBe("email.delete");
  });
});
