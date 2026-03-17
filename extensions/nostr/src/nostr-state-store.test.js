import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readNostrBusState,
  writeNostrBusState,
  computeSinceTimestamp
} from "./nostr-state-store.js";
import { setNostrRuntime } from "./runtime.js";
async function withTempStateDir(fn) {
  const previous = process.env.OPENCLAW_STATE_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-"));
  process.env.OPENCLAW_STATE_DIR = dir;
  setNostrRuntime({
    state: {
      resolveStateDir: (env, homedir) => {
        const stateEnv = env ?? process.env;
        const override = stateEnv.OPENCLAW_STATE_DIR?.trim() || stateEnv.CLAWDBOT_STATE_DIR?.trim();
        if (override) {
          return override;
        }
        const resolveHome = homedir ?? os.homedir;
        return path.join(resolveHome(), ".openclaw");
      }
    }
  });
  try {
    return await fn(dir);
  } finally {
    if (previous === void 0) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}
describe("nostr bus state store", () => {
  it("persists and reloads state across restarts", async () => {
    await withTempStateDir(async () => {
      expect(await readNostrBusState({ accountId: "test-bot" })).toBeNull();
      await writeNostrBusState({
        accountId: "test-bot",
        lastProcessedAt: 17e8,
        gatewayStartedAt: 1700000100
      });
      const state = await readNostrBusState({ accountId: "test-bot" });
      expect(state).toEqual({
        version: 2,
        lastProcessedAt: 17e8,
        gatewayStartedAt: 1700000100,
        recentEventIds: []
      });
    });
  });
  it("isolates state by accountId", async () => {
    await withTempStateDir(async () => {
      await writeNostrBusState({
        accountId: "bot-a",
        lastProcessedAt: 1e3,
        gatewayStartedAt: 1e3
      });
      await writeNostrBusState({
        accountId: "bot-b",
        lastProcessedAt: 2e3,
        gatewayStartedAt: 2e3
      });
      const stateA = await readNostrBusState({ accountId: "bot-a" });
      const stateB = await readNostrBusState({ accountId: "bot-b" });
      expect(stateA?.lastProcessedAt).toBe(1e3);
      expect(stateB?.lastProcessedAt).toBe(2e3);
    });
  });
});
describe("computeSinceTimestamp", () => {
  it("returns now for null state (fresh start)", () => {
    const now = 17e8;
    expect(computeSinceTimestamp(null, now)).toBe(now);
  });
  it("uses lastProcessedAt when available", () => {
    const state = {
      version: 2,
      lastProcessedAt: 1699999e3,
      gatewayStartedAt: null,
      recentEventIds: []
    };
    expect(computeSinceTimestamp(state, 17e8)).toBe(1699999e3);
  });
  it("uses gatewayStartedAt when lastProcessedAt is null", () => {
    const state = {
      version: 2,
      lastProcessedAt: null,
      gatewayStartedAt: 1699998e3,
      recentEventIds: []
    };
    expect(computeSinceTimestamp(state, 17e8)).toBe(1699998e3);
  });
  it("uses the max of both timestamps", () => {
    const state = {
      version: 2,
      lastProcessedAt: 1699999e3,
      gatewayStartedAt: 1699998e3,
      recentEventIds: []
    };
    expect(computeSinceTimestamp(state, 17e8)).toBe(1699999e3);
  });
  it("falls back to now if both are null", () => {
    const state = {
      version: 2,
      lastProcessedAt: null,
      gatewayStartedAt: null,
      recentEventIds: []
    };
    expect(computeSinceTimestamp(state, 17e8)).toBe(17e8);
  });
});
