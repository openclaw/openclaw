import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readNostrBusState,
  readNostrProfileState,
  normalizeNostrStateAccountId,
} from "./nostr-state-store.js";
import { detectNostrLegacyStateMigrations } from "./state-migrations.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  resetPluginStateStoreForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-nostr-migrate-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  resetPluginStateStoreForTests();
  return stateDir;
}

function applyContext(stateDir: string) {
  return {
    cfg: {},
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
  };
}

describe("Nostr legacy state migrations", () => {
  it("imports bus and profile JSON state into plugin state", async () => {
    const stateDir = makeStateDir();
    const sourceDir = path.join(stateDir, "nostr");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "bus-state-test-bot.json"),
      `${JSON.stringify({
        version: 2,
        lastProcessedAt: 1700000000,
        gatewayStartedAt: 1700000100,
        recentEventIds: ["evt-1", 2, null],
      })}\n`,
    );
    fs.writeFileSync(
      path.join(sourceDir, "profile-state-test-bot.json"),
      `${JSON.stringify({
        version: 1,
        lastPublishedAt: 1700000200,
        lastPublishedEventId: "evt-profile",
        lastPublishResults: {
          "wss://relay.example": "ok",
        },
      })}\n`,
    );

    const plan = detectNostrLegacyStateMigrations({ stateDir })[0];
    expect(plan).toMatchObject({
      label: "Nostr runtime state",
      recordCount: 2,
    });
    if (plan?.kind !== "custom") {
      throw new Error("expected custom Nostr migration plan");
    }

    const result = await plan.apply(applyContext(stateDir));

    expect(result.warnings).toEqual([]);
    expect(result.changes.join("\n")).toContain("Imported 2 Nostr runtime state");
    await expect(readNostrBusState({ accountId: "test-bot" })).resolves.toEqual({
      version: 2,
      lastProcessedAt: 1700000000,
      gatewayStartedAt: 1700000100,
      recentEventIds: ["evt-1"],
    });
    await expect(readNostrProfileState({ accountId: "test-bot" })).resolves.toEqual({
      version: 1,
      lastPublishedAt: 1700000200,
      lastPublishedEventId: "evt-profile",
      lastPublishResults: {
        "wss://relay.example": "ok",
      },
    });
    expect(
      fs.existsSync(
        path.join(sourceDir, `bus-state-${normalizeNostrStateAccountId("test-bot")}.json`),
      ),
    ).toBe(false);
    expect(fs.existsSync(path.join(sourceDir, "profile-state-test-bot.json"))).toBe(false);
  });
});
