import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_STATE_DIR = mkdtempSync(path.join(tmpdir(), "openclaw-sandbox-registry-"));
const SANDBOX_REGISTRY_PATH = path.join(TEST_STATE_DIR, "containers.json");
const SANDBOX_BROWSER_REGISTRY_PATH = path.join(TEST_STATE_DIR, "browsers.json");

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

type WriteDelayConfig = {
  containerName: string;
  browserName: string;
  containerDelayMs: number;
  browserDelayMs: number;
};

let writeDelayConfig: WriteDelayConfig = {
  containerName: "container-a",
  browserName: "browser-a",
  containerDelayMs: 0,
  browserDelayMs: 0,
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const realFsWriteFile = fs.writeFile;

function writeText(content: Parameters<typeof fs.writeFile>[1]): string {
  if (typeof content === "string") {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return Buffer.from(content).toString("utf-8");
  }
  if (ArrayBuffer.isView(content)) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString("utf-8");
  }
  return "";
}

beforeEach(() => {
  writeDelayConfig = {
    containerName: "container-a",
    browserName: "browser-a",
    containerDelayMs: 0,
    browserDelayMs: 0,
  };
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    const [target, content] = args;
    if (typeof target !== "string") {
      return realFsWriteFile(...args);
    }

    const payload = writeText(content);
    if (
      target.includes("containers.json") &&
      payload.includes(`"containerName":"${writeDelayConfig.containerName}"`) &&
      writeDelayConfig.containerDelayMs > 0
    ) {
      await delay(writeDelayConfig.containerDelayMs);
    }

    if (
      target.includes("browsers.json") &&
      payload.includes(`"containerName":"${writeDelayConfig.browserName}"`) &&
      writeDelayConfig.browserDelayMs > 0
    ) {
      await delay(writeDelayConfig.browserDelayMs);
    }
    return realFsWriteFile(...args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(TEST_STATE_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_STATE_DIR, { recursive: true });
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
    writeDelayConfig = {
      containerName: "container-a",
      browserName: "browser-a",
      containerDelayMs: 80,
      browserDelayMs: 0,
    };

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

  it("prevents concurrent container remove/update from resurrecting deleted entries", async () => {
    await seedContainerRegistry([containerEntry({ containerName: "container-x" })]);
    writeDelayConfig = {
      containerName: "container-x",
      browserName: "browser-a",
      containerDelayMs: 80,
      browserDelayMs: 0,
    };

    await Promise.all([
      removeRegistryEntry("container-x"),
      updateRegistry(containerEntry({ containerName: "container-x", configHash: "updated" })),
    ]);

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(0);
  });

  it("keeps both browser updates under concurrent writes", async () => {
    writeDelayConfig = {
      containerName: "container-a",
      browserName: "browser-a",
      containerDelayMs: 0,
      browserDelayMs: 80,
    };

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

  it("prevents concurrent browser remove/update from resurrecting deleted entries", async () => {
    await seedBrowserRegistry([browserEntry({ containerName: "browser-x" })]);
    writeDelayConfig = {
      containerName: "container-a",
      browserName: "browser-x",
      containerDelayMs: 0,
      browserDelayMs: 80,
    };

    await Promise.all([
      removeBrowserRegistryEntry("browser-x"),
      updateBrowserRegistry(browserEntry({ containerName: "browser-x", configHash: "updated" })),
    ]);

    const registry = await readBrowserRegistry();
    expect(registry.entries).toHaveLength(0);
  });
});
