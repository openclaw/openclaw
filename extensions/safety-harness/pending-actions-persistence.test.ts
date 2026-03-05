import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PendingActionStore } from "./pending-actions.js";

describe("PendingActionStore persistence", () => {
  let tmpDir: string;
  let store: PendingActionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pending-"));
    store = new PendingActionStore(path.join(tmpDir, "pending.json"));
  });

  afterEach(() => {
    store.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists actions to disk on add", () => {
    store.add({
      id: "action-1",
      tool: "email.delete",
      params: { count: 3 },
      nonce: "123456",
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
      status: "pending",
    });

    const filePath = path.join(tmpDir, "pending.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.actions).toHaveLength(1);
    expect(content.actions[0].id).toBe("action-1");
  });

  it("loads actions from disk on construction", () => {
    const filePath = path.join(tmpDir, "pending.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        actions: [
          {
            id: "action-1",
            tool: "email.delete",
            params: { count: 3 },
            nonce: "123456",
            createdAt: Date.now(),
            expiresAt: Date.now() + 300_000,
            status: "pending",
          },
        ],
      }),
    );

    const newStore = new PendingActionStore(filePath);
    expect(newStore.get("action-1")).toBeDefined();
  });

  it("survives restart (load after write)", () => {
    store.add({
      id: "action-1",
      tool: "email.delete",
      params: { count: 3 },
      nonce: "123456",
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
      status: "pending",
    });

    // Simulate restart: create new store instance from same file
    const restartedStore = new PendingActionStore(path.join(tmpDir, "pending.json"));
    expect(restartedStore.get("action-1")).toBeDefined();
    expect(restartedStore.get("action-1")?.tool).toBe("email.delete");
  });

  it("updates file on remove", () => {
    store.add({
      id: "action-1",
      tool: "email.delete",
      params: { count: 3 },
      nonce: "123456",
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
      status: "pending",
    });

    store.remove("action-1");

    const filePath = path.join(tmpDir, "pending.json");
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.actions).toHaveLength(0);
  });
});
