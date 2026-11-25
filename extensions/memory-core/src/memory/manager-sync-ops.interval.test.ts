// Memory Core tests cover resolved batch timeout bounds.
import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { MemorySyncTestHarness } from "./manager-sync-ops.test-support.js";

type MemoryIndexEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content?: string;
};

class BatchTimeoutHarness extends MemorySyncTestHarness {
  readonly sync = vi.fn(async () => {});
  protected readonly cfg = {} as OpenClawConfig;
  protected override readonly workspaceDir = "/tmp/openclaw-memory-interval-test";
  protected readonly settings: ResolvedMemorySearchConfig;
  protected publishedDatabase = new MemoryIndexDatabase({} as DatabaseSync);

  constructor(params: { batchTimeoutMinutes: number }) {
    super();
    this.settings = {
      remote: {
        batch: {
          enabled: true,
          timeoutMinutes: params.batchTimeoutMinutes,
        },
      },
    } as ResolvedMemorySearchConfig;
  }

  batchConfig(): ReturnType<MemorySyncTestHarness["resolveBatchConfig"]> {
    return this.resolveBatchConfig();
  }

  protected getIndexConcurrency(): number {
    return 1;
  }

  protected async indexFile(_entry: MemoryIndexEntry, _source: MemorySource): Promise<void> {}
}

describe("MemoryManagerSyncOps batch timeout", () => {
  it("clamps oversized batch timeout minutes", () => {
    const harness = new BatchTimeoutHarness({
      batchTimeoutMinutes: Number.MAX_SAFE_INTEGER,
    });

    expect(harness.batchConfig().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
