/**
 * Tests for legacy auth.json → auth-profiles.json migration behaviour in
 * loadAuthProfileStoreForAgent (via loadAgentLocalAuthProfileStore).
 *
 * These tests use a real temporary filesystem directory so the migration code
 * path is exercised end-to-end without mocking file I/O.
 *
 * Focus: fix for #2914491523 — with readOnly:true, legacy migration must still
 * persist auth-profiles.json so that updateAuthProfileStoreWithLock's
 * ensureAuthStoreFile does not create an empty file that causes toRemove
 * profiles to go un-removed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentLocalAuthProfileStore } from "./store.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function writeLegacyAuthJson(dir: string, data: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(data));
}

function readAuthProfilesJson(dir: string): Record<string, unknown> | null {
  const p = path.join(dir, "auth-profiles.json");
  if (!fs.existsSync(p)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("loadAgentLocalAuthProfileStore – legacy migration with readOnly:true (#2914491523)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-store-migration-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("migrates legacy auth.json to auth-profiles.json even when readOnly:true", () => {
    writeLegacyAuthJson(tmpDir, {
      anthropic: { type: "api_key", provider: "anthropic", key: "sk-test" },
    });

    const store = loadAgentLocalAuthProfileStore(tmpDir, { readOnly: true });

    // Profiles should be present in the returned store
    expect(store.profiles["anthropic:default"]).toBeDefined();
    expect(store.profiles["anthropic:default"]?.type).toBe("api_key");

    // auth-profiles.json must have been written (migration is unconditional)
    const migrated = readAuthProfilesJson(tmpDir);
    expect(migrated).not.toBeNull();
    expect((migrated as { profiles: Record<string, unknown> }).profiles).toMatchObject({
      "anthropic:default": { type: "api_key", provider: "anthropic" },
    });

    // legacy auth.json must have been deleted after successful migration
    expect(fs.existsSync(path.join(tmpDir, "auth.json"))).toBe(false);
  });

  it("returns in-memory profiles matching what was in auth.json (readOnly:true)", () => {
    writeLegacyAuthJson(tmpDir, {
      openai: { type: "api_key", provider: "openai", key: "sk-openai" },
      anthropic: { type: "token", provider: "anthropic", token: "tk-anth", expires: 9999999999 },
    });

    const store = loadAgentLocalAuthProfileStore(tmpDir, { readOnly: true });

    // Both legacy profiles should be migrated and visible
    expect(store.profiles["openai:default"]?.type).toBe("api_key");
    expect(store.profiles["anthropic:default"]?.type).toBe("token");
  });

  it("does not create auth-profiles.json when legacy auth.json is absent (readOnly:true)", () => {
    // No files in tmpDir — nothing to migrate
    loadAgentLocalAuthProfileStore(tmpDir, { readOnly: true });

    expect(readAuthProfilesJson(tmpDir)).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, "auth.json"))).toBe(false);
  });

  it("does not overwrite existing auth-profiles.json body when readOnly:true and no legacy", () => {
    // Write an existing auth-profiles.json (no auth.json)
    const existing = {
      version: 1,
      profiles: { "anthropic:existing": { type: "api_key", provider: "anthropic", key: "sk-ex" } },
    };
    fs.writeFileSync(path.join(tmpDir, "auth-profiles.json"), JSON.stringify(existing));

    // Load with readOnly:true — no legacy present, so no migration; existing file unchanged
    const store = loadAgentLocalAuthProfileStore(tmpDir, { readOnly: true });

    // In-memory store should have the existing profile
    expect(store.profiles["anthropic:existing"]).toBeDefined();

    // File content should be unchanged (readOnly suppresses external-CLI / OAuth sync)
    const after = readAuthProfilesJson(tmpDir);
    expect(after).toEqual(existing);
  });

  it("migration semantics are preserved when readOnly:false (existing behaviour)", () => {
    writeLegacyAuthJson(tmpDir, {
      anthropic: { type: "api_key", provider: "anthropic", key: "sk-test" },
    });

    const store = loadAgentLocalAuthProfileStore(tmpDir, { readOnly: false });

    expect(store.profiles["anthropic:default"]).toBeDefined();
    expect(readAuthProfilesJson(tmpDir)).not.toBeNull();
    // legacy auth.json should be deleted after migration
    expect(fs.existsSync(path.join(tmpDir, "auth.json"))).toBe(false);
  });

  it("ensures updateAuthProfileStoreWithLock sees migrated profiles, not empty store", async () => {
    // This is the core regression test for #2914491523:
    // Before the fix, the sequence was:
    //   1. Probe (readOnly:true) reads legacy profiles into memory but does NOT persist
    //   2. updateAuthProfileStoreWithLock calls ensureAuthStoreFile → creates empty auth-profiles.json
    //   3. Write-enabled load inside the lock reads the empty file → returns {}
    //   4. toRemove profiles were never deleted
    //
    // After the fix, step 1 persists the migration, so step 3 reads the migrated profiles.
    writeLegacyAuthJson(tmpDir, {
      anthropic: { type: "api_key", provider: "anthropic", key: "sk-legacy" },
    });

    // Simulate the probe (readOnly:true) — must create auth-profiles.json
    loadAgentLocalAuthProfileStore(tmpDir, { readOnly: true });

    // Simulate what ensureAuthStoreFile does (no-op when file already exists)
    const authProfilesPath = path.join(tmpDir, "auth-profiles.json");
    expect(fs.existsSync(authProfilesPath)).toBe(true); // migration created it

    // Simulate the write-enabled load inside the lock (readOnly:false default)
    const freshStore = loadAgentLocalAuthProfileStore(tmpDir, { readOnly: false });

    // The write-enabled load must see the migrated profiles, not an empty store
    expect(Object.keys(freshStore.profiles)).toContain("anthropic:default");
  });
});
