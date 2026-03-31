import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEmbeddingMocks } from "./embedding.test-mocks.js";
import { MemoryIndexManager } from "./manager.js";
import { getRequiredMemoryIndexManager } from "./test-manager-helpers.js";

type ReadonlyRecoveryHarness = {
  closed: boolean;
  syncing: Promise<void> | null;
  queuedSessionFiles: Set<string>;
  queuedSessionSync: Promise<void> | null;
  db: DatabaseSync;
  vectorReady: Promise<boolean> | null;
  vector: {
    enabled: boolean;
    available: boolean | null;
    loadError?: string;
    dims?: number;
  };
  readonlyRecoveryAttempts: number;
  readonlyRecoverySuccesses: number;
  readonlyRecoveryFailures: number;
  readonlyRecoveryLastError?: string;
  ensureProviderInitialized: ReturnType<typeof vi.fn>;
  enqueueTargetedSessionSync: ReturnType<typeof vi.fn>;
  runSync: ReturnType<typeof vi.fn>;
  openDatabase: ReturnType<typeof vi.fn>;
  ensureSchema: ReturnType<typeof vi.fn>;
  readMeta: ReturnType<typeof vi.fn>;
};

describe("memory manager readonly recovery", () => {
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  function createMemoryConfig(): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            cache: { enabled: false },
            query: { minScore: 0, hybrid: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  async function createRealManager() {
    manager = await getRequiredMemoryIndexManager({
      cfg: createMemoryConfig(),
      agentId: "main",
      purpose: "status",
    });
    return manager;
  }

  function createReadonlyRecoveryHarness() {
    const reopenedClose = vi.fn();
    const initialClose = vi.fn();
    const reopenedDb = { close: reopenedClose } as unknown as DatabaseSync;
    const initialDb = { close: initialClose } as unknown as DatabaseSync;
    const harness: ReadonlyRecoveryHarness = {
      closed: false,
      syncing: null,
      queuedSessionFiles: new Set<string>(),
      queuedSessionSync: null,
      db: initialDb,
      vectorReady: null,
      vector: {
        enabled: false,
        available: null,
        loadError: "stale",
        dims: 123,
      },
      readonlyRecoveryAttempts: 0,
      readonlyRecoverySuccesses: 0,
      readonlyRecoveryFailures: 0,
      readonlyRecoveryLastError: undefined,
      ensureProviderInitialized: vi.fn(async () => {}),
      enqueueTargetedSessionSync: vi.fn(async () => {}),
      runSync: vi.fn(),
      openDatabase: vi.fn(() => reopenedDb),
      ensureSchema: vi.fn(),
      readMeta: vi.fn(() => undefined),
    };
    Object.setPrototypeOf(harness, MemoryIndexManager.prototype);
    return {
      harness,
      initialDb,
      initialClose,
      reopenedDb,
      reopenedClose,
    };
  }

  function expectReadonlyRecoveryStatus(
    instance: {
      readonlyRecoveryAttempts: number;
      readonlyRecoverySuccesses: number;
      readonlyRecoveryFailures: number;
      readonlyRecoveryLastError?: string;
    },
    lastError: string,
  ) {
    expect({
      attempts: instance.readonlyRecoveryAttempts,
      successes: instance.readonlyRecoverySuccesses,
      failures: instance.readonlyRecoveryFailures,
      lastError: instance.readonlyRecoveryLastError,
    }).toEqual({
      attempts: 1,
      successes: 1,
      failures: 0,
      lastError,
    });
  }

  async function expectReadonlyRetry(params: { firstError: unknown; expectedLastError: string }) {
    const { harness, initialClose } = createReadonlyRecoveryHarness();
    harness.runSync.mockRejectedValueOnce(params.firstError).mockResolvedValueOnce(undefined);

    await MemoryIndexManager.prototype.sync.call(harness as unknown as MemoryIndexManager, {
      reason: "test",
    });

    expect(harness.runSync).toHaveBeenCalledTimes(2);
    expect(harness.openDatabase).toHaveBeenCalledTimes(1);
    expect(initialClose).toHaveBeenCalledTimes(1);
    expectReadonlyRecoveryStatus(harness, params.expectedLastError);
  }

  beforeEach(async () => {
    resetEmbeddingMocks();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-readonly-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello memory.");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("reopens sqlite and retries once when sync hits SQLITE_READONLY", async () => {
    await expectReadonlyRetry({
      firstError: new Error("attempt to write a readonly database"),
      expectedLastError: "attempt to write a readonly database",
    });
  });

  it("reopens sqlite and retries when readonly appears in error code", async () => {
    await expectReadonlyRetry({
      firstError: { message: "write failed", code: "SQLITE_READONLY" },
      expectedLastError: "write failed",
    });
  });

  it("does not retry non-readonly sync errors", async () => {
    const { harness, initialClose } = createReadonlyRecoveryHarness();
    harness.runSync.mockRejectedValueOnce(new Error("embedding timeout"));

    await expect(
      MemoryIndexManager.prototype.sync.call(harness as unknown as MemoryIndexManager, {
        reason: "test",
      }),
    ).rejects.toThrow("embedding timeout");
    expect(harness.runSync).toHaveBeenCalledTimes(1);
    expect(harness.openDatabase).not.toHaveBeenCalled();
    expect(initialClose).not.toHaveBeenCalled();
  });

  it("sets busy_timeout on memory sqlite connections", async () => {
    const currentManager = await createRealManager();
    const db = (currentManager as unknown as { db: DatabaseSync }).db;
    const row = db.prepare("PRAGMA busy_timeout").get() as
      | { busy_timeout?: number; timeout?: number }
      | undefined;
    const busyTimeout = row?.busy_timeout ?? row?.timeout;
    expect(busyTimeout).toBe(5000);
  });
});
