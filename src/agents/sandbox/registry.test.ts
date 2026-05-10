import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";

const { TEST_STATE_DIR, SANDBOX_STATE_DIR, SANDBOX_CONTAINERS_DIR, SANDBOX_BROWSERS_DIR } =
  vi.hoisted(() => {
    const path = require("node:path");
    const { mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const baseDir = mkdtempSync(path.join(tmpdir(), "openclaw-sandbox-registry-"));
    const sandboxDir = path.join(baseDir, "sandbox");

    return {
      TEST_STATE_DIR: baseDir,
      SANDBOX_STATE_DIR: sandboxDir,
      SANDBOX_CONTAINERS_DIR: path.join(sandboxDir, "containers"),
      SANDBOX_BROWSERS_DIR: path.join(sandboxDir, "browsers"),
    };
  });

vi.mock("./constants.js", () => ({
  SANDBOX_STATE_DIR,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_BROWSERS_DIR,
}));

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

const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;

beforeEach(() => {
  process.env.OPENCLAW_STATE_DIR = TEST_STATE_DIR;
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(SANDBOX_CONTAINERS_DIR, { recursive: true, force: true });
  await fs.rm(SANDBOX_BROWSERS_DIR, { recursive: true, force: true });
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

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
    throw new Error(`expected ${targetPath} to be missing`);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    expect(code).toBe("ENOENT");
  }
}

describe("registry race safety", () => {
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
});
