import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import {
  readNostrBusState,
  readNostrProfileState,
  writeNostrBusState,
  writeNostrProfileState,
  computeSinceTimestamp,
} from "./nostr-state-store.js";
import { setNostrRuntime } from "./runtime.js";

describe("nostr state store", () => {
  let previous: string | undefined;
  let dir: string;
  beforeEach(async () => {
    previous = process.env.OPENCLAW_STATE_DIR;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-"));
    process.env.OPENCLAW_STATE_DIR = dir;
    resetPluginStateStoreForTests();
    setNostrRuntime({
      state: {
        openKeyedStore: (options: OpenKeyedStoreOptions) =>
          createPluginStateKeyedStoreForTests("nostr", {
            ...options,
            env: { ...process.env, OPENCLAW_STATE_DIR: dir },
          }),
      },
    } as PluginRuntime);
  });
  afterEach(async () => {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
    // The keyed store keeps the state database open under the temporary dir, so Windows
    // fails the removal with EBUSY unless the cached handle is released first.
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const writeBus = (
    accountId: string,
    lastProcessedAt: number,
    gatewayStartedAt = lastProcessedAt,
  ) => writeNostrBusState({ accountId, lastProcessedAt, gatewayStartedAt });

  it("isolates state by accountId", async () => {
    await writeBus("bot-a", 1000);
    await writeBus("bot-b", 2000);

    const stateA = await readNostrBusState({ accountId: "bot-a" });
    const stateB = await readNostrBusState({ accountId: "bot-b" });

    expect(stateA?.lastProcessedAt).toBe(1000);
    expect(stateB?.lastProcessedAt).toBe(2000);
  });

  it("preserves legacy account key bytes for state lookup", async () => {
    await writeBus(" Team.A ", 1234, 1200);

    await expect(readNostrBusState({ accountId: "Team.A" })).resolves.toMatchObject({
      lastProcessedAt: 1234,
    });
    await expect(readNostrBusState({ accountId: "team-a" })).resolves.toBeNull();
  });

  it("persists and reloads profile publish state", async () => {
    const profile = {
      lastPublishedAt: 1700000000,
      lastPublishedEventId: "evt-1",
      lastPublishResults: { "wss://relay.example": "ok" as const },
    };
    await writeNostrProfileState({ accountId: "test-bot", ...profile });

    const state = await readNostrProfileState({ accountId: "test-bot" });
    expect(state).toEqual({ version: 1, ...profile });
  });
});

describe("computeSinceTimestamp", () => {
  const state = (
    lastProcessedAt: number | null,
    gatewayStartedAt: number | null,
  ): NonNullable<Parameters<typeof computeSinceTimestamp>[0]> => ({
    version: 2,
    lastProcessedAt,
    gatewayStartedAt,
    recentEventIds: [],
  });
  it("returns now for null state (fresh start)", () => {
    const now = 1700000000;
    expect(computeSinceTimestamp(null, now)).toBe(now);
  });

  it("uses the max of both timestamps", () => {
    expect(computeSinceTimestamp(state(1699999000, 1699998000), 1700000000)).toBe(1699999000);
  });

  it("falls back to now if both are null", () => {
    expect(computeSinceTimestamp(state(null, null), 1700000000)).toBe(1700000000);
  });
});
