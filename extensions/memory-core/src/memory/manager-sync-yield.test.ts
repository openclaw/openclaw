import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { buildSessionTranscriptEntryMock } = vi.hoisted(() => ({
  buildSessionTranscriptEntryMock: vi.fn(),
}));

vi.mock("undici", () => ({
  Agent: vi.fn(),
  EnvHttpProxyAgent: vi.fn(),
  ProxyAgent: vi.fn(),
  fetch: vi.fn(),
  getGlobalDispatcher: vi.fn(),
  setGlobalDispatcher: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => {
  return {
    buildSessionTranscriptEntry: buildSessionTranscriptEntryMock,
    listSessionTranscriptScopesForAgent: vi.fn(async () => []),
    sessionTranscriptKeyForScope: (scope: { agentId: string; sessionId: string }) =>
      `transcript:${scope.agentId}:${scope.sessionId}`,
  };
});

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: vi.fn(),
}));

import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

type MemoryIndexEntry = {
  path: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content?: string;
  messageCount?: number;
};

function createDbMock(): DatabaseSync {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => undefined),
      run: vi.fn(),
    })),
  } as unknown as DatabaseSync;
}

class SessionSyncYieldHarness extends MemoryManagerSyncOps {
  protected readonly cfg = {} as OpenClawConfig;
  protected readonly agentId = "main";
  protected readonly workspaceDir = "/tmp/openclaw-test-workspace";
  protected readonly settings = {
    sync: {
      sessions: {
        deltaBytes: 100_000,
        deltaMessages: 50,
        postCompactionForce: true,
      },
    },
  } as ResolvedMemorySearchConfig;
  protected readonly batch = {
    enabled: false,
    wait: false,
    concurrency: 1,
    pollIntervalMs: 0,
    timeoutMs: 0,
  };
  protected readonly vector = { enabled: false, available: false };
  protected readonly cache = { enabled: false };
  protected db = createDbMock();

  readonly indexedPaths: string[] = [];

  constructor(private readonly onIndexFile: (count: number) => void) {
    super();
  }

  async syncTargetSessionTranscripts(
    scopes: Array<{ agentId: string; sessionId: string }>,
  ): Promise<void> {
    await (
      this as unknown as {
        syncSessionTranscripts: (params: {
          needsFullReindex: boolean;
          targetSessionTranscriptKeys: string[];
        }) => Promise<void>;
      }
    ).syncSessionTranscripts({
      needsFullReindex: false,
      targetSessionTranscriptKeys: scopes.map((scope) => `${scope.agentId}\0${scope.sessionId}`),
    });
  }

  protected computeProviderKey(): string {
    return "test";
  }

  protected async sync(): Promise<void> {}

  protected async withTimeout<T>(
    promise: Promise<T>,
    _timeoutMs: number,
    _message: string,
  ): Promise<T> {
    return await promise;
  }

  protected getIndexConcurrency(): number {
    return 1;
  }

  protected pruneEmbeddingCacheIfNeeded(): void {}

  protected async indexFile(
    entry: MemoryIndexEntry,
    _options: { source: MemorySource; content?: string },
  ): Promise<void> {
    this.indexedPaths.push(entry.path);
    this.onIndexFile(this.indexedPaths.length);
  }
}

describe("session sync responsiveness", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(os.tmpdir(), "openclaw-session-sync-yield"));
    buildSessionTranscriptEntryMock.mockImplementation(
      async (scope: { agentId: string; sessionId: string }) => {
        return {
          scope,
          path: `transcript:${scope.agentId}:${scope.sessionId}`,
          mtimeMs: 1,
          size: 1,
          hash: `hash-${scope.sessionId}`,
          content: `user message for ${scope.sessionId}`,
          messageCount: 1,
          lineMap: [1],
          messageTimestampsMs: [1],
        };
      },
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("yields to the event loop between session transcript batches", async () => {
    const scopes = Array.from({ length: 11 }, (_value, index) => ({
      agentId: "main",
      sessionId: `session-${index}`,
    }));
    let immediateRan = false;
    const immediate = new Promise<void>((resolve) => {
      setImmediate(() => {
        immediateRan = true;
        resolve();
      });
    });
    const observedBeforeLastFile: boolean[] = [];
    const harness = new SessionSyncYieldHarness((count) => {
      if (count === 11) {
        observedBeforeLastFile.push(immediateRan);
      }
    });

    await harness.syncTargetSessionTranscripts(scopes);

    expect(harness.indexedPaths).toHaveLength(scopes.length);
    expect(observedBeforeLastFile).toEqual([true]);
    await immediate;
  });
});
