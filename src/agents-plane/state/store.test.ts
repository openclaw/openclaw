import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlaneConfig, PlaneState } from "../types.js";
import { LocalStateStore } from "./store.js";

function makePlaneConfig(name = "test-plane"): PlaneConfig {
  return {
    name,
    identity: { provider: "google-workspace", domain: "test.com" },
    infra: {
      provider: "gcp",
      project: "test-project",
      region: "us-east4",
      defaults: { machineType: "e2-small", diskSizeGb: 20 },
    },
    secrets: { provider: "gcp-secret-manager", project: "test-project" },
    network: { provider: "iap" },
  };
}

function makePlaneState(name = "test-plane"): PlaneState {
  return {
    config: makePlaneConfig(name),
    agents: {},
    version: 0,
    updatedAt: new Date().toISOString(),
  };
}

describe("LocalStateStore", () => {
  let dir: string;
  let store: LocalStateStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-plane-state-"));
    store = new LocalStateStore(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null for non-existent plane", async () => {
    expect(await store.load("nonexistent")).toBeNull();
  });

  it("saves and loads plane state", async () => {
    const state = makePlaneState();
    await store.save(state);
    const loaded = await store.load("test-plane");
    expect(loaded).not.toBeNull();
    expect(loaded!.config.name).toBe("test-plane");
    expect(loaded!.version).toBe(1);
  });

  it("increments version on each save", async () => {
    const state = makePlaneState();
    await store.save(state);
    const loaded = (await store.load("test-plane"))!;
    await store.save(loaded);
    const loaded2 = (await store.load("test-plane"))!;
    expect(loaded2.version).toBe(2);
  });

  it("lists plane IDs", async () => {
    await store.save(makePlaneState("plane-a"));
    await store.save(makePlaneState("plane-b"));
    const list = await store.list();
    expect(list.toSorted()).toEqual(["plane-a", "plane-b"]);
  });

  it("returns empty list for non-existent directory", async () => {
    const emptyStore = new LocalStateStore("/tmp/nonexistent-agents-plane-dir");
    expect(await emptyStore.list()).toEqual([]);
  });

  it("lock and unlock works", async () => {
    const unlock = await store.lock("test-plane");
    // Second lock should fail
    await expect(store.lock("test-plane")).rejects.toThrow(/is locked/);
    await unlock();
    // Should work after unlock
    const unlock2 = await store.lock("test-plane");
    await unlock2();
  });

  it("expired lock can be acquired", async () => {
    // Write an expired lock manually
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "test-plane.lock"),
      JSON.stringify({
        holder: 99999,
        acquired: Date.now() - 120_000,
        expires: Date.now() - 60_000,
      }),
    );
    const unlock = await store.lock("test-plane");
    await unlock();
  });
});
