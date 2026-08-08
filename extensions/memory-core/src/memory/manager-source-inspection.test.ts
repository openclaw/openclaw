// Memory Core tests cover lightweight status source inspection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./embedding.test-mocks.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

const inspectionMocks = vi.hoisted(() => ({
  buildFileEntry: vi.fn(),
  listMemoryFiles: vi.fn(),
  statRegularFile: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: inspectionMocks.warn,
    }),
  };
});

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-storage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-storage")>();
  inspectionMocks.buildFileEntry.mockImplementation(actual.buildFileEntry);
  inspectionMocks.listMemoryFiles.mockImplementation(actual.listMemoryFiles);
  inspectionMocks.statRegularFile.mockImplementation(actual.statRegularFile);
  return {
    ...actual,
    buildFileEntry: inspectionMocks.buildFileEntry,
    listMemoryFiles: inspectionMocks.listMemoryFiles,
    statRegularFile: inspectionMocks.statRegularFile,
  };
});

import {
  closeAllMemorySearchManagers,
  getMemorySearchManager,
  type MemoryIndexManager,
} from "./index.js";

describe("memory source status inspection", () => {
  let fixtureRoot = "";
  let workspaceDir = "";

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-source-inspection-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Indexed memory\n", "utf8");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeAllMemorySearchManagers();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function createCfg(): OpenClawConfig {
    return isolateMemoryManagerTestConfig({
      memory: {
        backend: "builtin",
        search: {
          provider: "none",
          store: { vector: { enabled: false } },
          cache: { enabled: false },
          sources: ["memory"],
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
      agents: {
        defaults: { workspace: workspaceDir },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig);
  }

  async function requireManager(params: {
    purpose?: "default" | "status" | "cli";
    inspectSourceState?: boolean;
  }): Promise<MemoryIndexManager> {
    const result = await getMemorySearchManager({
      cfg: createCfg(),
      agentId: "main",
      ...params,
    });
    if (!result.manager || !("sync" in result.manager)) {
      throw new Error(result.error ?? "manager missing");
    }
    return result.manager as MemoryIndexManager;
  }

  async function syncBaseline(): Promise<void> {
    const manager = await requireManager({});
    await manager.sync({ reason: "test", force: true });
    await manager.close();
    inspectionMocks.buildFileEntry.mockClear();
    inspectionMocks.listMemoryFiles.mockClear();
    inspectionMocks.statRegularFile.mockClear();
    inspectionMocks.warn.mockClear();
  }

  it("compares only file metadata for an unchanged corpus", async () => {
    await syncBaseline();

    const manager = await requireManager({ purpose: "status", inspectSourceState: true });

    expect(manager.status().dirty).toBe(false);
    expect(inspectionMocks.listMemoryFiles).toHaveBeenCalledTimes(1);
    expect(inspectionMocks.statRegularFile).toHaveBeenCalledTimes(1);
    expect(inspectionMocks.buildFileEntry).not.toHaveBeenCalled();
    await manager.close();
  });

  it("marks a newly discovered memory file dirty without reading its contents", async () => {
    await syncBaseline();
    await fs.writeFile(path.join(workspaceDir, "memory", "new.md"), "new content\n", "utf8");

    const manager = await requireManager({ purpose: "status", inspectSourceState: true });

    expect(manager.status().dirty).toBe(true);
    expect(inspectionMocks.statRegularFile).toHaveBeenCalledTimes(2);
    expect(inspectionMocks.buildFileEntry).not.toHaveBeenCalled();
    await manager.close();
  });

  it("fails closed and logs the reason when the source scan fails", async () => {
    await syncBaseline();
    inspectionMocks.listMemoryFiles.mockRejectedValueOnce(new Error("scan exploded"));

    const manager = await requireManager({ purpose: "status", inspectSourceState: true });

    expect(manager.status().dirty).toBe(true);
    expect(inspectionMocks.buildFileEntry).not.toHaveBeenCalled();
    expect(inspectionMocks.warn).toHaveBeenCalledWith(
      "memory status source inspection failed: scan exploded",
    );
    await manager.close();
  });

  it("does not inspect source metadata for ordinary status-purpose callers", async () => {
    await syncBaseline();

    const manager = await requireManager({ purpose: "status" });

    expect(inspectionMocks.listMemoryFiles).not.toHaveBeenCalled();
    expect(inspectionMocks.statRegularFile).not.toHaveBeenCalled();
    expect(inspectionMocks.buildFileEntry).not.toHaveBeenCalled();
    await manager.close();
  });

  it("serializes concurrent inspections without sharing transient managers", async () => {
    await syncBaseline();

    const [first, second] = await Promise.all([
      requireManager({ purpose: "status", inspectSourceState: true }),
      requireManager({ purpose: "status", inspectSourceState: true }),
    ]);

    expect(first).not.toBe(second);
    expect(first.status().dirty).toBe(false);
    expect(second.status().dirty).toBe(false);
    expect(inspectionMocks.listMemoryFiles).toHaveBeenCalledTimes(2);
    expect(inspectionMocks.buildFileEntry).not.toHaveBeenCalled();
    await first.close();
    await second.close();
  });
});
