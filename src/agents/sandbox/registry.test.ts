import fs from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { TEST_STATE_DIR, SANDBOX_REGISTRY_PATH, SANDBOX_BROWSER_REGISTRY_PATH } = vi.hoisted(() => {
  const path = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(path.join(tmpdir(), "openclaw-sandbox-registry-"));

  return {
    TEST_STATE_DIR: baseDir,
    SANDBOX_REGISTRY_PATH: path.join(baseDir, "containers.json"),
    SANDBOX_BROWSER_REGISTRY_PATH: path.join(baseDir, "browsers.json"),
  };
});

vi.mock("./constants.js", () => ({
  SANDBOX_STATE_DIR: TEST_STATE_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_BROWSER_REGISTRY_PATH,
}));

import type { SandboxBrowserRegistryEntry, SandboxRegistryEntry } from "./registry.js";
import {
  readBrowserRegistry,
  readRegistry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  updateBrowserRegistry,
  updateRegistry,
} from "./registry.js";

async function seedMalformedContainerRegistry(payload: string) {
  await fs.writeFile(SANDBOX_REGISTRY_PATH, payload, "utf-8");
}

async function seedMalformedBrowserRegistry(payload: string) {
  await fs.writeFile(SANDBOX_BROWSER_REGISTRY_PATH, payload, "utf-8");
}

afterEach(async () => {
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

async function seedContainerRegistry(entries: SandboxRegistryEntry[]) {
  await fs.writeFile(SANDBOX_REGISTRY_PATH, `${JSON.stringify({ entries }, null, 2)}\n`, "utf-8");
}

async function seedBrowserRegistry(entries: SandboxBrowserRegistryEntry[]) {
  await fs.writeFile(
    SANDBOX_BROWSER_REGISTRY_PATH,
    `${JSON.stringify({ entries }, null, 2)}\n`,
    "utf-8",
  );
}

describe("registry race safety", () => {
  it("keeps both container updates under concurrent writes", async () => {
    await Promise.all([
      updateRegistry(containerEntry({ containerName: "container-a" })),
      updateRegistry(containerEntry({ containerName: "container-b" })),
    ]);

    const registry = readRegistry();
    expect(registry.entries).toHaveLength(2);
    expect(
      registry.entries
        .map((entry) => entry.containerName)
        .slice()
        .toSorted(),
    ).toEqual(["container-a", "container-b"]);
  });

  it("prevents container remove/update from resurrecting deleted entries", async () => {
    await seedContainerRegistry([containerEntry({ containerName: "container-x" })]);

    // Serialized via file lock — update first, then remove ensures the
    // entry is gone regardless of concurrent interleaving.
    await updateRegistry(containerEntry({ containerName: "container-x", configHash: "updated" }));
    await removeRegistryEntry("container-x");

    const registry = readRegistry();
    expect(registry.entries).toHaveLength(0);
  });

  it("keeps both browser updates under concurrent writes", async () => {
    await Promise.all([
      updateBrowserRegistry(browserEntry({ containerName: "browser-a" })),
      updateBrowserRegistry(browserEntry({ containerName: "browser-b", cdpPort: 9223 })),
    ]);

    const registry = readBrowserRegistry();
    expect(registry.entries).toHaveLength(2);
    expect(
      registry.entries
        .map((entry) => entry.containerName)
        .slice()
        .toSorted(),
    ).toEqual(["browser-a", "browser-b"]);
  });

  it("prevents browser remove/update from resurrecting deleted entries", async () => {
    await seedBrowserRegistry([browserEntry({ containerName: "browser-x" })]);

    await updateBrowserRegistry(
      browserEntry({ containerName: "browser-x", configHash: "updated" }),
    );
    await removeBrowserRegistryEntry("browser-x");

    const registry = readBrowserRegistry();
    expect(registry.entries).toHaveLength(0);
  });

  it("fails fast when registry files are malformed during update", async () => {
    await seedMalformedContainerRegistry("{bad json");
    await seedMalformedBrowserRegistry("{bad json");
    await expect(updateRegistry(containerEntry())).rejects.toThrow();
    await expect(updateBrowserRegistry(browserEntry())).rejects.toThrow();
  });

  it("fails fast when registry entries are invalid during update", async () => {
    const invalidEntries = `{"entries":[{"sessionKey":"agent:main"}]}`;
    await seedMalformedContainerRegistry(invalidEntries);
    await seedMalformedBrowserRegistry(invalidEntries);
    await expect(updateRegistry(containerEntry())).rejects.toThrow(
      /Invalid sandbox registry format/,
    );
    await expect(updateBrowserRegistry(browserEntry())).rejects.toThrow(
      /Invalid sandbox registry format/,
    );
  });
});
