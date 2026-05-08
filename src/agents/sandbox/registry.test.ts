import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";

const {
  TEST_STATE_DIR,
  SANDBOX_STATE_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_BROWSERS_DIR,
} = vi.hoisted(() => {
  const path = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(path.join(tmpdir(), "openclaw-sandbox-registry-"));
  const sandboxDir = path.join(baseDir, "sandbox");

  return {
    TEST_STATE_DIR: baseDir,
    SANDBOX_STATE_DIR: sandboxDir,
    SANDBOX_REGISTRY_PATH: path.join(sandboxDir, "containers.json"),
    SANDBOX_BROWSER_REGISTRY_PATH: path.join(sandboxDir, "browsers.json"),
    SANDBOX_CONTAINERS_DIR: path.join(sandboxDir, "containers"),
    SANDBOX_BROWSERS_DIR: path.join(sandboxDir, "browsers"),
  };
});

vi.mock("./constants.js", () => ({
  SANDBOX_STATE_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_BROWSERS_DIR,
}));

import { migrateLegacySandboxRegistryFiles } from "../../commands/doctor-sandbox-registry-migration.js";
import {
  readBrowserRegistry,
  readRegistry,
  readRegistryEntry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  updateBrowserRegistry,
  updateRegistry,
} from "./registry.js";

type SandboxBrowserRegistryEntry = import("./registry.js").SandboxBrowserRegistryEntry;
type SandboxRegistryEntry = import("./registry.js").SandboxRegistryEntry;
type MigrationResult = Awaited<ReturnType<typeof migrateLegacySandboxRegistryFiles>>[number];

const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;

async function seedMalformedContainerRegistry(payload: string) {
  await fs.mkdir(path.dirname(SANDBOX_REGISTRY_PATH), { recursive: true });
  await fs.writeFile(SANDBOX_REGISTRY_PATH, payload, "utf-8");
}

async function seedMalformedBrowserRegistry(payload: string) {
  await fs.mkdir(path.dirname(SANDBOX_BROWSER_REGISTRY_PATH), { recursive: true });
  await fs.writeFile(SANDBOX_BROWSER_REGISTRY_PATH, payload, "utf-8");
}

beforeEach(() => {
  process.env.OPENCLAW_STATE_DIR = TEST_STATE_DIR;
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(SANDBOX_CONTAINERS_DIR, { recursive: true, force: true });
  await fs.rm(SANDBOX_BROWSERS_DIR, { recursive: true, force: true });
  await fs.rm(SANDBOX_REGISTRY_PATH, { force: true });
  await fs.rm(SANDBOX_BROWSER_REGISTRY_PATH, { force: true });
  await fs.rm(`${SANDBOX_REGISTRY_PATH}.lock`, { force: true });
  await fs.rm(`${SANDBOX_BROWSER_REGISTRY_PATH}.lock`, { force: true });
  await fs.rm(path.join(TEST_STATE_DIR, "state"), { recursive: true, force: true });
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
});

afterAll(async () => {
  await fs.rm(TEST_STATE_DIR, { recursive: true, force: true });
});

function browserEntry(
  overrides: Partial<SandboxBrowserRegistryEntry> = {},
): SandboxBrowserRegistryEntry {
  return {
    containerName: "browser-a",
    sessionKey: "agent:main",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "openclaw-browser:test",
    cdpPort: 9222,
    ...overrides,
  };
}

function containerEntry(overrides: Partial<SandboxRegistryEntry> = {}): SandboxRegistryEntry {
  return {
    containerName: "container-a",
    sessionKey: "agent:main",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "openclaw-sandbox:test",
    ...overrides,
  };
}

async function seedContainerRegistry(entries: SandboxRegistryEntry[]) {
  await fs.mkdir(path.dirname(SANDBOX_REGISTRY_PATH), { recursive: true });
  await fs.writeFile(SANDBOX_REGISTRY_PATH, `${JSON.stringify({ entries }, null, 2)}\n`, "utf-8");
}

async function seedBrowserRegistry(entries: SandboxBrowserRegistryEntry[]) {
  await fs.mkdir(path.dirname(SANDBOX_BROWSER_REGISTRY_PATH), { recursive: true });
  await fs.writeFile(
    SANDBOX_BROWSER_REGISTRY_PATH,
    `${JSON.stringify({ entries }, null, 2)}\n`,
    "utf-8",
  );
}

async function seedStaleLock(lockPath: string) {
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({ pid: 999_999_999, createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
    "utf-8",
  );
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
    throw new Error(`expected ${targetPath} to be missing`);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    expect(code).toBe("ENOENT");
  }
}

function requireMigrationResult(
  results: readonly MigrationResult[],
  kind: MigrationResult["kind"],
): MigrationResult {
  const result = results.find((candidate) => candidate.kind === kind);
  if (!result) {
    throw new Error(`expected migration result for ${kind}`);
  }
  return result;
}

async function seedContainerShard(entry: SandboxRegistryEntry) {
  await fs.mkdir(SANDBOX_CONTAINERS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(SANDBOX_CONTAINERS_DIR, `${entry.containerName}.json`),
    `${JSON.stringify(entry)}\n`,
    "utf-8",
  );
}

async function seedBrowserShard(entry: SandboxBrowserRegistryEntry) {
  await fs.mkdir(SANDBOX_BROWSERS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(SANDBOX_BROWSERS_DIR, `${entry.containerName}.json`),
    `${JSON.stringify(entry)}\n`,
    "utf-8",
  );
}

describe("registry race safety", () => {
  it("does not migrate legacy registry files from runtime reads", async () => {
    await seedContainerRegistry([containerEntry({ containerName: "legacy-container" })]);

    await expect(readRegistry()).resolves.toEqual({ entries: [] });
    await expect(readRegistryEntry("legacy-container")).resolves.toBeNull();
    await expect(fs.access(SANDBOX_REGISTRY_PATH)).resolves.toBeUndefined();
  });

  it("normalizes legacy registry entries after explicit migration", async () => {
    await seedContainerRegistry([
      {
        containerName: "legacy-container",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw-sandbox:test",
      },
    ]);

    await migrateLegacySandboxRegistryFiles();
    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(1);
    const [entry] = registry.entries;
    expect(entry?.containerName).toBe("legacy-container");
    expect(entry?.backendId).toBe("docker");
    expect(entry?.runtimeLabel).toBe("legacy-container");
    expect(entry?.configLabelKind).toBe("Image");
  });

  it("migrates legacy container and browser registry files after explicit repair", async () => {
    await seedContainerRegistry([
      containerEntry({
        containerName: "legacy-container",
        sessionKey: "agent:legacy",
        lastUsedAtMs: 7,
        configHash: "legacy-container-hash",
      }),
    ]);
    await seedBrowserRegistry([
      browserEntry({
        containerName: "legacy-browser",
        sessionKey: "agent:legacy",
        cdpPort: 9333,
        noVncPort: 6081,
        configHash: "legacy-browser-hash",
      }),
    ]);
    await seedStaleLock(`${SANDBOX_REGISTRY_PATH}.lock`);
    await seedStaleLock(`${SANDBOX_BROWSER_REGISTRY_PATH}.lock`);

    const migrationResults = await migrateLegacySandboxRegistryFiles();
    const containerMigration = requireMigrationResult(migrationResults, "containers");
    const browserMigration = requireMigrationResult(migrationResults, "browsers");
    expect(containerMigration.status).toBe("migrated");
    expect(containerMigration.entries).toBe(1);
    expect(browserMigration.status).toBe("migrated");
    expect(browserMigration.entries).toBe(1);

    await expectPathMissing(SANDBOX_REGISTRY_PATH);
    await expectPathMissing(SANDBOX_BROWSER_REGISTRY_PATH);
    await expectPathMissing(`${SANDBOX_REGISTRY_PATH}.lock`);
    await expectPathMissing(`${SANDBOX_BROWSER_REGISTRY_PATH}.lock`);
    const containerRegistry = await readRegistry();
    expect(containerRegistry.entries).toHaveLength(1);
    const [container] = containerRegistry.entries;
    expect(container?.containerName).toBe("legacy-container");
    expect(container?.backendId).toBe("docker");
    expect(container?.runtimeLabel).toBe("legacy-container");
    expect(container?.sessionKey).toBe("agent:legacy");
    expect(container?.configHash).toBe("legacy-container-hash");
    const browserRegistry = await readBrowserRegistry();
    expect(browserRegistry.entries).toHaveLength(1);
    const [browser] = browserRegistry.entries;
    expect(browser?.containerName).toBe("legacy-browser");
    expect(browser?.sessionKey).toBe("agent:legacy");
    expect(browser?.cdpPort).toBe(9333);
    expect(browser?.noVncPort).toBe(6081);
    expect(browser?.configHash).toBe("legacy-browser-hash");
  });

  it("migrates legacy sharded container and browser registry entries", async () => {
    await seedContainerShard(
      containerEntry({
        containerName: "legacy-shard-container",
        sessionKey: "agent:legacy-shard",
      }),
    );
    await seedBrowserShard(
      browserEntry({
        containerName: "legacy-shard-browser",
        sessionKey: "agent:legacy-shard",
        cdpPort: 9334,
      }),
    );

    await expect(migrateLegacySandboxRegistryFiles()).resolves.toEqual([
      expect.objectContaining({ kind: "containers", status: "migrated", entries: 1 }),
      expect.objectContaining({ kind: "browsers", status: "migrated", entries: 1 }),
    ]);

    await expect(fs.access(SANDBOX_CONTAINERS_DIR)).rejects.toThrow();
    await expect(fs.access(SANDBOX_BROWSERS_DIR)).rejects.toThrow();
    await expect(readRegistryEntry("legacy-shard-container")).resolves.toEqual(
      expect.objectContaining({ sessionKey: "agent:legacy-shard" }),
    );
    await expect(readBrowserRegistry()).resolves.toEqual({
      entries: [expect.objectContaining({ containerName: "legacy-shard-browser", cdpPort: 9334 })],
    });
  });

  it("does not overwrite newer SQLite entries during legacy migration", async () => {
    await updateRegistry(
      containerEntry({
        containerName: "container-a",
        sessionKey: "new-session",
        lastUsedAtMs: 10,
      }),
    );
    await seedContainerRegistry([
      containerEntry({
        containerName: "container-a",
        sessionKey: "legacy-session",
        lastUsedAtMs: 1,
      }),
    ]);

    await migrateLegacySandboxRegistryFiles();

    const entry = await readRegistryEntry("container-a");
    expect(entry?.sessionKey).toBe("new-session");
    expect(entry?.lastUsedAtMs).toBe(10);
  });

  it("reads a single SQLite entry without scanning the full registry", async () => {
    await updateRegistry(containerEntry({ containerName: "container-x", sessionKey: "sess:x" }));
    await updateRegistry(containerEntry({ containerName: "container-y", sessionKey: "sess:y" }));

    const entry = await readRegistryEntry("container-x");
    expect(entry?.containerName).toBe("container-x");
    expect(entry?.sessionKey).toBe("sess:x");
    await expect(readRegistryEntry("missing-container")).resolves.toBeNull();
  });

  it("keeps container registry readable from SQLite without compatibility shards", async () => {
    await updateRegistry(
      containerEntry({ containerName: "container-sqlite", sessionKey: "sess:x" }),
    );

    await expect(fs.access(SANDBOX_CONTAINERS_DIR)).rejects.toThrow();
    await expect(readRegistryEntry("container-sqlite")).resolves.toEqual(
      expect.objectContaining({
        containerName: "container-sqlite",
        sessionKey: "sess:x",
      }),
    );
    await expect(readRegistry()).resolves.toEqual({
      entries: [
        expect.objectContaining({
          containerName: "container-sqlite",
          sessionKey: "sess:x",
        }),
      ],
    });
  });

  it("keeps SQLite container registry primary when compatibility shards are stale", async () => {
    const entry = containerEntry({
      containerName: "container-stale-shard",
      sessionKey: "sqlite-session",
    });
    await updateRegistry(entry);
    await seedContainerShard({ ...entry, sessionKey: "stale-json-session" });

    await expect(readRegistry()).resolves.toEqual({
      entries: [
        expect.objectContaining({
          containerName: "container-stale-shard",
          sessionKey: "sqlite-session",
        }),
      ],
    });
  });

  it("keeps both container updates under concurrent writes", async () => {
    await Promise.all([
      updateRegistry(containerEntry({ containerName: "container-a" })),
      updateRegistry(containerEntry({ containerName: "container-b" })),
    ]);

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(2);
    expect(
      registry.entries
        .map((entry) => entry.containerName)
        .slice()
        .toSorted(),
    ).toEqual(["container-a", "container-b"]);
  });

  it("removes container entries from SQLite", async () => {
    await updateRegistry(containerEntry({ containerName: "container-x" }));
    await removeRegistryEntry("container-x");

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(0);
  });

  it("stores unsafe container names without creating filesystem paths", async () => {
    await updateRegistry(containerEntry({ containerName: "../escape" }));

    const registry = await readRegistry();

    expect(registry.entries.map((entry) => entry.containerName)).toEqual(["../escape"]);
    await expectPathMissing(`${TEST_STATE_DIR}/escape.json`);
    await expectPathMissing(SANDBOX_CONTAINERS_DIR);
  });

  it("returns registry entries in deterministic container-name order", async () => {
    await Promise.all([
      updateRegistry(containerEntry({ containerName: "container-c" })),
      updateRegistry(containerEntry({ containerName: "container-a" })),
      updateRegistry(containerEntry({ containerName: "container-b" })),
    ]);

    const registry = await readRegistry();
    expect(registry.entries.map((entry) => entry.containerName)).toEqual([
      "container-a",
      "container-b",
      "container-c",
    ]);
  });

  it("keeps both browser updates under concurrent writes", async () => {
    await Promise.all([
      updateBrowserRegistry(browserEntry({ containerName: "browser-a" })),
      updateBrowserRegistry(browserEntry({ containerName: "browser-b", cdpPort: 9223 })),
    ]);

    const registry = await readBrowserRegistry();
    expect(registry.entries).toHaveLength(2);
    expect(
      registry.entries
        .map((entry) => entry.containerName)
        .slice()
        .toSorted(),
    ).toEqual(["browser-a", "browser-b"]);
  });

  it("keeps browser registry readable from SQLite without compatibility shards", async () => {
    await updateBrowserRegistry(
      browserEntry({ containerName: "browser-sqlite", sessionKey: "sess:browser" }),
    );

    await expect(fs.access(SANDBOX_BROWSERS_DIR)).rejects.toThrow();
    await expect(readBrowserRegistry()).resolves.toEqual({
      entries: [
        expect.objectContaining({
          containerName: "browser-sqlite",
          sessionKey: "sess:browser",
        }),
      ],
    });
  });

  it("removes browser entries from SQLite", async () => {
    await updateBrowserRegistry(browserEntry({ containerName: "browser-x" }));
    await removeBrowserRegistryEntry("browser-x");

    const registry = await readBrowserRegistry();
    expect(registry.entries).toHaveLength(0);
  });

  it("quarantines malformed legacy registry files during migration", async () => {
    await seedMalformedContainerRegistry("{bad json");
    await seedMalformedBrowserRegistry("{bad json");
    const results = await migrateLegacySandboxRegistryFiles();

    await expectPathMissing(SANDBOX_REGISTRY_PATH);
    await expectPathMissing(SANDBOX_BROWSER_REGISTRY_PATH);
    expect(results.map((result) => result.status)).toEqual([
      "quarantined-invalid",
      "quarantined-invalid",
    ]);
  });

  it("quarantines legacy registry files with invalid entries during migration", async () => {
    const invalidEntries = `{"entries":[{"sessionKey":"agent:main"}]}`;
    await seedMalformedContainerRegistry(invalidEntries);
    await seedMalformedBrowserRegistry(invalidEntries);
    const migrationResults = await migrateLegacySandboxRegistryFiles();
    expect(requireMigrationResult(migrationResults, "containers").status).toBe(
      "quarantined-invalid",
    );
    expect(requireMigrationResult(migrationResults, "browsers").status).toBe("quarantined-invalid");
  });
});
