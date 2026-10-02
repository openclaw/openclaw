import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

// Exercise real empty-state operations without materializing client runtimes.
vi.mock("matrix-js-sdk/lib/matrix.js", () => {
  throw new Error("Matrix SDK loaded by a Doctor migration");
});
vi.mock("fake-indexeddb", () => {
  throw new Error("IndexedDB runtime loaded without a legacy snapshot");
});
vi.mock("openclaw/plugin-sdk/doctor-repair-runtime", () => {
  throw new Error("Schema repair runtime loaded without an account database");
});
vi.mock("./src/matrix/client/storage.js", () => {
  throw new Error("Client storage loaded by an absent-state Doctor migration");
});
vi.mock("./src/account-selection.js", () => {
  throw new Error("Account topology loaded without legacy credential sources");
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("refuses retired JSON state without changing it or inspecting token-root archives", async () => {
  const stateDir = tempDirs.make("matrix-retired-state-");
  const sources = [
    path.join(stateDir, "matrix", "accounts", "default", "thread-bindings.json"),
    path.join(
      stateDir,
      "matrix",
      "accounts",
      "ops",
      "matrix.example.org__bot",
      "0123456789abcdef",
      "startup-verification.json",
    ),
  ];
  const archive = path.join(
    stateDir,
    "matrix",
    "accounts",
    "ops",
    "matrix.example.org__bot",
    "sync-cache-backup",
    "thread-bindings.json",
  );
  for (const file of [...sources, archive]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"retained":true}\n');
  }
  const { stateMigrations } = await import("./doctor-contract-api.js");
  const migration = stateMigrations.find((entry) => entry.id === "matrix-account-sqlite-schema")!;
  const openPluginStateKeyedStore = vi.fn(() => {
    throw new Error("retired state must not open a store");
  });
  const params = {
    config: {},
    env: { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: { openPluginStateKeyedStore },
  };
  for (const run of [migration.detectLegacyState, migration.migrateLegacyState]) {
    const result = run(params);
    await expect(result).rejects.toThrow("Install OpenClaw 2026.9.5");
    for (const file of sources) {
      await expect(result).rejects.toThrow(file);
    }
    await expect(result).rejects.not.toThrow(archive);
  }
  expect(openPluginStateKeyedStore).not.toHaveBeenCalled();
  for (const file of [...sources, archive]) {
    expect(fs.readFileSync(file, "utf8")).toBe('{"retained":true}\n');
  }
});

it("completes absent legacy-state checks without loading client runtimes", async () => {
  const stateDir = tempDirs.make("openclaw-matrix-doctor-import-");
  const { stateMigrations } = await import("./doctor-contract-api.js");
  const openPluginStateKeyedStore = vi.fn(() => {
    throw new Error("absent legacy sources must not open a state store");
  });
  const params = {
    config: {},
    env: { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: { openPluginStateKeyedStore },
  };
  for (const id of [
    "matrix-account-sqlite-schema",
    "matrix-storage-meta-json-to-plugin-state",
    "matrix-sync-cache-json-to-plugin-state",
    "matrix-legacy-crypto-migration-json-to-plugin-state",
  ]) {
    const migration = stateMigrations.find((entry) => entry.id === id);
    if (!migration) {
      throw new Error(`Missing migration: ${id}`);
    }
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  }
  const credentials = stateMigrations.find(
    (entry) => entry.id === "matrix-credentials-json-to-plugin-state",
  );
  if (!credentials) {
    throw new Error("Missing credential migration");
  }
  await expect(credentials.detectLegacyState(params)).resolves.toBeNull();
  const credentialsDir = path.join(stateDir, "credentials", "matrix");
  fs.mkdirSync(credentialsDir, { recursive: true });
  await expect(credentials.detectLegacyState(params)).resolves.toBeNull();
  fs.writeFileSync(path.join(credentialsDir, "unrelated.json"), "{}");
  fs.mkdirSync(path.join(credentialsDir, "credentials-ops.json"));
  await expect(credentials.detectLegacyState(params)).resolves.toBeNull();
  expect(openPluginStateKeyedStore).not.toHaveBeenCalled();
});
