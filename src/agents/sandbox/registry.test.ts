import fs from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const {
  TEST_STATE_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_BROWSERS_DIR,
} = vi.hoisted(() => {
  const p = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(p.join(tmpdir(), "openclaw-sandbox-registry-"));
  return {
    TEST_STATE_DIR: baseDir,
    SANDBOX_REGISTRY_PATH: p.join(baseDir, "containers.json"),
    SANDBOX_BROWSER_REGISTRY_PATH: p.join(baseDir, "browsers.json"),
    SANDBOX_CONTAINERS_DIR: p.join(baseDir, "containers"),
    SANDBOX_BROWSERS_DIR: p.join(baseDir, "browsers"),
  };
});

vi.mock("./constants.js", () => ({
  SANDBOX_STATE_DIR: TEST_STATE_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_BROWSER_REGISTRY_PATH,
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

afterEach(async () => {
  await fs.rm(SANDBOX_CONTAINERS_DIR, { recursive: true, force: true });
  await fs.rm(SANDBOX_BROWSERS_DIR, { recursive: true, force: true });
  await fs.rm(SANDBOX_REGISTRY_PATH, { force: true });
  await fs.rm(SANDBOX_BROWSER_REGISTRY_PATH, { force: true });
  await fs.rm(`${SANDBOX_REGISTRY_PATH}.lock`, { force: true });
  await fs.rm(`${SANDBOX_BROWSER_REGISTRY_PATH}.lock`, { force: true });
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

async function seedMonolithicContainerRegistry(entries: SandboxRegistryEntry[]) {
  await fs.writeFile(SANDBOX_REGISTRY_PATH, `${JSON.stringify({ entries }, null, 2)}\n`, "utf-8");
}

async function seedMonolithicBrowserRegistry(entries: SandboxBrowserRegistryEntry[]) {
  await fs.writeFile(
    SANDBOX_BROWSER_REGISTRY_PATH,
    `${JSON.stringify({ entries }, null, 2)}\n`,
    "utf-8",
  );
}

describe("per-file sharded container registry", () => {
  it("writes and reads a single container entry", async () => {
    await updateRegistry(containerEntry({ containerName: "container-a" }));

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0].containerName).toBe("container-a");
  });

  it("keeps both container updates under concurrent writes", async () => {
    // The old monolithic-file model serialized every writer through a
    // single lock. Per-entry files must handle concurrent upserts of
    // different containers without any ordering or contention.
    await Promise.all([
      updateRegistry(containerEntry({ containerName: "container-a" })),
      updateRegistry(containerEntry({ containerName: "container-b" })),
    ]);

    const registry = await readRegistry();
    expect(
      registry.entries
        .map((entry) => entry.containerName)
        .slice()
        .toSorted(),
    ).toEqual(["container-a", "container-b"]);
  });

  it("readRegistryEntry returns a single entry without scanning the whole dir", async () => {
    await updateRegistry(containerEntry({ containerName: "container-x", sessionKey: "sess:x" }));
    await updateRegistry(containerEntry({ containerName: "container-y", sessionKey: "sess:y" }));

    const entry = await readRegistryEntry("container-x");
    expect(entry).not.toBeNull();
    expect(entry?.containerName).toBe("container-x");
    expect(entry?.sessionKey).toBe("sess:x");
  });

  it("readRegistryEntry returns null when the container has no entry file", async () => {
    const missing = await readRegistryEntry("nonexistent-container");
    expect(missing).toBeNull();
  });

  it("removeRegistryEntry deletes only the target container file", async () => {
    await updateRegistry(containerEntry({ containerName: "container-a" }));
    await updateRegistry(containerEntry({ containerName: "container-b" }));
    await removeRegistryEntry("container-a");

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0].containerName).toBe("container-b");
  });

  it("removeRegistryEntry is a no-op for a container that never existed", async () => {
    // force:true on rm swallows ENOENT — callers should not have to
    // check existence first.
    await expect(removeRegistryEntry("never-created")).resolves.toBeUndefined();
  });

  it("updateRegistry preserves createdAtMs and image from an existing entry", async () => {
    await updateRegistry(
      containerEntry({
        containerName: "c",
        createdAtMs: 100,
        lastUsedAtMs: 100,
        image: "original:tag",
      }),
    );
    await updateRegistry(
      containerEntry({
        containerName: "c",
        createdAtMs: 999,
        lastUsedAtMs: 200,
        image: "ignored:tag",
      }),
    );

    const entry = await readRegistryEntry("c");
    expect(entry?.createdAtMs).toBe(100);
    expect(entry?.lastUsedAtMs).toBe(200);
    expect(entry?.image).toBe("original:tag");
  });

  it("readRegistry normalizes legacy entries that lack backendId/runtimeLabel/configLabelKind", async () => {
    await seedMonolithicContainerRegistry([
      {
        containerName: "legacy-container",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw-sandbox:test",
      },
    ]);

    const registry = await readRegistry();
    expect(registry.entries).toEqual([
      expect.objectContaining({
        containerName: "legacy-container",
        backendId: "docker",
        runtimeLabel: "legacy-container",
        configLabelKind: "Image",
      }),
    ]);
  });

  it("skips a single corrupt per-entry file without hiding the other entries", async () => {
    // A crashed writer that left behind a partial JSON file must not
    // prevent other containers from being enumerated.
    await updateRegistry(containerEntry({ containerName: "good-a" }));
    await updateRegistry(containerEntry({ containerName: "good-b" }));
    await fs.writeFile(`${SANDBOX_CONTAINERS_DIR}/corrupt.json`, "{not json", "utf-8");

    const registry = await readRegistry();
    expect(
      registry.entries
        .map((entry) => entry.containerName)
        .slice()
        .toSorted(),
    ).toEqual(["good-a", "good-b"]);
  });
});

describe("per-file sharded browser registry", () => {
  it("writes and reads both browser entries under concurrent writes", async () => {
    await Promise.all([
      updateBrowserRegistry(browserEntry({ containerName: "browser-a" })),
      updateBrowserRegistry(browserEntry({ containerName: "browser-b", cdpPort: 9223 })),
    ]);

    const registry = await readBrowserRegistry();
    expect(
      registry.entries
        .map((entry) => entry.containerName)
        .slice()
        .toSorted(),
    ).toEqual(["browser-a", "browser-b"]);
  });

  it("removes a single browser entry", async () => {
    await updateBrowserRegistry(browserEntry({ containerName: "browser-a" }));
    await removeBrowserRegistryEntry("browser-a");

    const registry = await readBrowserRegistry();
    expect(registry.entries).toHaveLength(0);
  });
});

describe("monolithic → per-file migration", () => {
  it("migrates container entries from the legacy containers.json on first read", async () => {
    await seedMonolithicContainerRegistry([
      containerEntry({ containerName: "old-a", sessionKey: "sess:a" }),
      containerEntry({ containerName: "old-b", sessionKey: "sess:b" }),
    ]);

    const registry = await readRegistry();
    expect(
      registry.entries
        .map((entry) => entry.containerName)
        .slice()
        .toSorted(),
    ).toEqual(["old-a", "old-b"]);

    // Legacy file is removed once migration succeeds, so subsequent reads
    // go straight to the sharded dir.
    await expect(fs.access(SANDBOX_REGISTRY_PATH)).rejects.toThrow();
  });

  it("cleans up the stale .lock file alongside the migrated registry", async () => {
    await seedMonolithicContainerRegistry([containerEntry({ containerName: "old-a" })]);
    await fs.writeFile(`${SANDBOX_REGISTRY_PATH}.lock`, "stale", "utf-8");

    await readRegistry();
    await expect(fs.access(`${SANDBOX_REGISTRY_PATH}.lock`)).rejects.toThrow();
  });

  it("migrates browser entries from the legacy browsers.json", async () => {
    await seedMonolithicBrowserRegistry([
      browserEntry({ containerName: "old-br-a" }),
      browserEntry({ containerName: "old-br-b", cdpPort: 9223 }),
    ]);

    const registry = await readBrowserRegistry();
    expect(registry.entries).toHaveLength(2);
    await expect(fs.access(SANDBOX_BROWSER_REGISTRY_PATH)).rejects.toThrow();
  });

  it("drops a malformed legacy containers.json rather than throwing forever", async () => {
    // A corrupt legacy file would otherwise block every sandbox operation
    // on every boot — dropping it lets the operator recover just by
    // creating a new container.
    await fs.writeFile(SANDBOX_REGISTRY_PATH, "{bad json", "utf-8");

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(0);
    await expect(fs.access(SANDBOX_REGISTRY_PATH)).rejects.toThrow();
  });

  it("drops a legacy containers.json whose entries fail schema validation", async () => {
    // entries missing containerName cannot be migrated safely. Rather
    // than preserving the bad file, we remove it — the lost data was
    // unusable anyway, and keeping it around would block future boots.
    await fs.writeFile(SANDBOX_REGISTRY_PATH, `{"entries":[{"sessionKey":"agent:main"}]}`, "utf-8");

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(0);
    await expect(fs.access(SANDBOX_REGISTRY_PATH)).rejects.toThrow();
  });
});
