import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshAuthProfileFileState } from "./file-state.js";
import { clearAuthProfileMigrationDiagnostics } from "./legacy-source-diagnostic.js";
import { hasAuthProfileStoreSourceForProvider } from "./source-check.js";
import { readPersistedAuthProfileStoreRaw, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { loadAuthProfileStoreForRuntime, updateAuthProfileStoreWithLock } from "./store-runtime.js";

let agentDir: string;
const apiKey = { type: "api_key", provider: "openai", key: "sk-test" };
const unreadable = { version: 1, profiles: "invalid-profile-map" };
const write = (profiles: unknown) =>
  writePersistedAuthProfileStoreRaw({ version: 1, profiles }, agentDir);
const load = () => loadAuthProfileStoreForRuntime(agentDir);
const hasSource = (profileIds?: readonly string[]) =>
  hasAuthProfileStoreSourceForProvider("openai", agentDir, { profileIds });
const writeLegacy = (profiles: unknown) =>
  fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(profiles));

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-source-"));
  const stateDir = path.join(root, "state");
  agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});
afterEach(() => vi.unstubAllEnvs());

it("counts legacy aliases, then retires the migrated source", async () => {
  await writeLegacy({ openai: { mode: "apiKey", apiKey: "sk-test" } });
  expect(hasSource()).toBe(true);
  expect(load).toThrow("requires legacy credential migration");
  await fs.rename(path.join(agentDir, "auth.json"), path.join(agentDir, "auth.json.migrated"));
  await refreshAuthProfileFileState();
  clearAuthProfileMigrationDiagnostics();
  expect(load().profiles).toEqual({});
});

it.each([
  [
    "malformed providers",
    {
      "openai:default": { type: "api_key", key: "sk-test" },
      "openai:other": { ...apiKey, provider: 123 },
    },
  ],
  ["empty credentials", { "openai:default": { type: "api_key", provider: "openai" } }],
] as const)("ignores %s as credential evidence", (_name, profiles) => {
  write(profiles);
  expect(hasSource()).toBe(false);
});

it("routes structurally unreadable SQLite rows through the fail-closed loader", () => {
  write({});
  writePersistedAuthProfileStoreRaw(unreadable, agentDir);
  expect(hasSource()).toBe(true);
  expect(load).toThrow("is unreadable");
});

it("rejects unreadable rows inside write transactions without invoking the updater", async () => {
  write({});
  writePersistedAuthProfileStoreRaw(unreadable, agentDir);
  const updater = vi.fn(() => true);
  await expect(updateAuthProfileStoreWithLock({ agentDir, updater })).rejects.toThrow(
    "is unreadable; run openclaw doctor --fix",
  );
  expect(updater).not.toHaveBeenCalled();
  expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadable);
});

it("returns null for classified SQLite lock contention", async () => {
  write({});
  const updater = () => {
    throw Object.assign(new Error("database is locked"), { errcode: 5 });
  };
  await expect(updateAuthProfileStoreWithLock({ agentDir, updater })).resolves.toBeNull();
});

it("detects a legacy source that appears after an earlier clean load", async () => {
  write({});
  expect(load().profiles).toEqual({});
  await writeLegacy({ openai: { type: "api_key", key: "fake-late-key" } });
  await refreshAuthProfileFileState();
  expect(hasSource()).toBe(true);
  expect(load).toThrow("requires legacy credential migration");
});

it.each([
  ["expired then usable", [["openai:expired"], ["openai:default"]], [false, true]],
  ["explicitly empty", [[]], [false]],
] as const)("honors %s configured profile order", (_name, orders, expected) => {
  write({
    "openai:default": apiKey,
    "openai:expired": {
      type: "token",
      provider: "openai",
      token: "expired",
      expires: Date.now() - 1000,
    },
  });
  expect(orders.map(hasSource)).toEqual(expected);
});
