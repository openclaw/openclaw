import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  readNostrBusState,
  writeNostrBusState,
  writeNostrBusStateSync,
  readNostrProfileState,
  writeNostrProfileState,
  computeSinceTimestamp,
} from "./nostr-state-store.js";
import { setNostrRuntime } from "./runtime.js";

async function withTempStateDir<T>(fn: (dir: string) => Promise<T>) {
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
      },
    },
  } as PluginRuntime);
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) {
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
      // Fresh start - no state
      expect(await readNostrBusState({ accountId: "test-bot" })).toBeNull();

      // Write state
      await writeNostrBusState({
        accountId: "test-bot",
        lastProcessedAt: 1700000000,
        gatewayStartedAt: 1700000100,
      });

      // Read it back
      const state = await readNostrBusState({ accountId: "test-bot" });
      expect(state).toEqual({
        version: 2,
        lastProcessedAt: 1700000000,
        gatewayStartedAt: 1700000100,
        recentEventIds: [],
      });
    });
  });

  it("isolates state by accountId", async () => {
    await withTempStateDir(async () => {
      await writeNostrBusState({
        accountId: "bot-a",
        lastProcessedAt: 1000,
        gatewayStartedAt: 1000,
      });
      await writeNostrBusState({
        accountId: "bot-b",
        lastProcessedAt: 2000,
        gatewayStartedAt: 2000,
      });

      const stateA = await readNostrBusState({ accountId: "bot-a" });
      const stateB = await readNostrBusState({ accountId: "bot-b" });

      expect(stateA?.lastProcessedAt).toBe(1000);
      expect(stateB?.lastProcessedAt).toBe(2000);
    });
  });

  it("writes state synchronously for shutdown-safe persistence", async () => {
    await withTempStateDir(async () => {
      writeNostrBusStateSync({
        accountId: "sync-bot",
        lastProcessedAt: 1700001111,
        gatewayStartedAt: 1700002222,
        recentEventIds: ["evt-a", "evt-b"],
      });

      const state = await readNostrBusState({ accountId: "sync-bot" });
      expect(state).toEqual({
        version: 2,
        lastProcessedAt: 1700001111,
        gatewayStartedAt: 1700002222,
        recentEventIds: ["evt-a", "evt-b"],
      });
    });
  });
});

describe("nostr profile state store", () => {
  it("persists and reloads profile state with fingerprint", async () => {
    await withTempStateDir(async () => {
      expect(await readNostrProfileState({ accountId: "profile-bot" })).toBeNull();

      await writeNostrProfileState({
        accountId: "profile-bot",
        lastPublishedProfileFingerprint: "abc123def",
        lastPublishedAt: 1700000000,
        lastPublishedEventId: "event-id-1",
        lastPublishResults: { "wss://relay.damus.io": "ok" },
      });

      const state = await readNostrProfileState({ accountId: "profile-bot" });
      expect(state).toEqual({
        version: 1,
        lastPublishedProfileFingerprint: "abc123def",
        lastPublishedAt: 1700000000,
        lastPublishedEventId: "event-id-1",
        lastPublishResults: { "wss://relay.damus.io": "ok" },
      });
    });
  });

  it("accepts legacy profile state missing fingerprint", async () => {
    await withTempStateDir(async (dir) => {
      const legacyPath = path.join(dir, "nostr", "profile-state-profile-bot.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        JSON.stringify({
          version: 1,
          lastPublishedAt: 1700000000,
          lastPublishedEventId: "event-id-legacy",
          lastPublishResults: { "wss://relay.damus.io": "ok" },
        }),
      );

      const state = await readNostrProfileState({ accountId: "profile-bot" });
      expect(state).toEqual({
        version: 1,
        lastPublishedProfileFingerprint: null,
        lastPublishedAt: 1700000000,
        lastPublishedEventId: "event-id-legacy",
        lastPublishResults: { "wss://relay.damus.io": "ok" },
      });
    });
  });
});

describe("computeSinceTimestamp", () => {
  it("returns now for null state (fresh start)", () => {
    const now = 1700000000;
    expect(computeSinceTimestamp(null, now)).toBe(now);
  });

  it("uses lastProcessedAt when available", () => {
    const state: Parameters<typeof computeSinceTimestamp>[0] = {
      version: 2,
      lastProcessedAt: 1699999000,
      gatewayStartedAt: null,
      recentEventIds: [],
    };
    expect(computeSinceTimestamp(state, 1700000000)).toBe(1699999000);
  });

  it("uses gatewayStartedAt when lastProcessedAt is null", () => {
    const state: Parameters<typeof computeSinceTimestamp>[0] = {
      version: 2,
      lastProcessedAt: null,
      gatewayStartedAt: 1699998000,
      recentEventIds: [],
    };
    expect(computeSinceTimestamp(state, 1700000000)).toBe(1699998000);
  });

  it("uses the max of both timestamps", () => {
    const state: Parameters<typeof computeSinceTimestamp>[0] = {
      version: 2,
      lastProcessedAt: 1699999000,
      gatewayStartedAt: 1699998000,
      recentEventIds: [],
    };
    expect(computeSinceTimestamp(state, 1700000000)).toBe(1699999000);
  });

  it("falls back to now if both are null", () => {
    const state: Parameters<typeof computeSinceTimestamp>[0] = {
      version: 2,
      lastProcessedAt: null,
      gatewayStartedAt: null,
      recentEventIds: [],
    };
    expect(computeSinceTimestamp(state, 1700000000)).toBe(1700000000);
  });
});
