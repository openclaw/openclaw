// Memory Core tests cover manager sync ops.startup catchup plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { emitSessionTranscriptUpdate } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemorySource,
  MemorySyncParams,
  MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

type MemoryIndexEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content?: string;
};

type SyncParams = {
  reason?: string;
  force?: boolean;
  sessions?: MemorySyncParams["sessions"];
  sessionFiles?: string[];
  progress?: (update: MemorySyncProgressUpdate) => void;
};

type MemorySessionTranscriptUpdate = {
  agentId?: string;
  sessionFile?: string;
  sessionKey?: string;
  target?: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
  };
};

type MemoryTranscriptUpdateSubscriber = (
  listener: (update: MemorySessionTranscriptUpdate) => void,
) => () => void;

const MEMORY_CORE_TRANSCRIPT_UPDATE_SUBSCRIBER_KEY = Symbol.for(
  "openclaw.memoryCore.sessionTranscriptUpdateSubscriber",
);

type SourceStateRow = { path: string; hash: string; mtime: number; size: number };

class SessionStartupCatchupHarness extends MemoryManagerSyncOps {
  protected readonly cfg = {} as OpenClawConfig;
  protected readonly agentId = "main";
  protected readonly workspaceDir = "/tmp/openclaw-test-workspace";
  protected readonly settings = {
    chunking: {
      overlap: 0,
      tokens: 256,
    },
    extraPaths: [],
    multimodal: {
      enabled: false,
      modalities: [],
      maxFileBytes: 0,
    },
    provider: "none",
    store: {
      fts: {
        tokenizer: "unicode61",
      },
      vector: {
        enabled: false,
      },
    },
    sync: {
      sessions: {
        deltaBytes: 100_000,
        deltaMessages: 50,
        postCompactionForce: true,
      },
    },
  } as unknown as ResolvedMemorySearchConfig;
  protected readonly batch = {
    enabled: false,
    wait: false,
    concurrency: 1,
    pollIntervalMs: 0,
    timeoutMs: 0,
  };
  protected readonly vector = { enabled: false, available: false };
  protected readonly cache = { enabled: false };
  protected providerUnavailableReason?: string;
  protected providerLifecycle = { mode: "active" as const, providerId: "test" };
  protected db: DatabaseSync;

  readonly syncCalls: SyncParams[] = [];
  readonly indexedPaths: string[] = [];
  readonly indexedContents: string[] = [];

  constructor(sourceRows: SourceStateRow[]) {
    super();
    this.sources.add("sessions");
    this.db = {
      prepare: () => ({
        all: () => sourceRows,
        get: () => undefined,
        run: () => undefined,
      }),
    } as unknown as DatabaseSync;
  }

  async catchUp(): Promise<string[]> {
    return await this.runSessionStartupCatchup();
  }

  async markStartupDirtyFiles(): Promise<string[]> {
    return await this.markSessionStartupCatchupDirtyFiles();
  }

  async runSyncForTest(params?: MemorySyncParams): Promise<void> {
    await this.runSync(params);
  }

  getDirtySessionFiles(): string[] {
    return Array.from(this.sessionsDirtyFiles);
  }

  getPendingSessionTargets(): MemorySyncParams["sessions"] {
    return Array.from(this.sessionPendingTargets.values());
  }

  getPendingSessionFiles(): string[] {
    return Array.from(this.sessionPendingFiles);
  }

  addPendingSessionTarget(target: NonNullable<MemorySyncParams["sessions"]>[number]): void {
    this.sessionPendingTargets.set(
      [target.agentId ?? "", target.sessionId, target.sessionKey ?? ""].join("\0"),
      target,
    );
  }

  async processPendingSessionDeltas(): Promise<void> {
    await (
      this as unknown as {
        processSessionDeltaBatch: () => Promise<void>;
      }
    ).processSessionDeltaBatch();
  }

  async combineTargetSessionFilesForTest(params: {
    sessions?: MemorySyncParams["sessions"];
    sessionFiles?: string[];
  }): Promise<Set<string> | null> {
    return await (
      this as unknown as {
        combineTargetSessionFiles: (params: {
          sessions?: MemorySyncParams["sessions"];
          sessionFiles?: string[];
        }) => Promise<Set<string> | null>;
      }
    ).combineTargetSessionFiles(params);
  }

  isSessionsDirty(): boolean {
    return this.sessionsDirty;
  }

  startTranscriptListener(): void {
    this.ensureSessionListener();
  }

  stopTranscriptListener(): void {
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = null;
  }

  protected computeProviderKey(): string {
    return "test";
  }

  protected resolveProviderIndexIdentities() {
    return [];
  }

  protected async sync(params?: MemorySyncParams): Promise<void> {
    this.syncCalls.push(params ?? {});
  }

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

  protected resetProviderInitializationForRetry(): void {}

  protected assertRequiredProviderAvailable(): void {}

  protected async indexFile(
    entry: MemoryIndexEntry,
    options: { source: MemorySource; content?: string },
  ): Promise<void> {
    this.indexedPaths.push(entry.path);
    this.indexedContents.push(options.content ?? "");
  }
}

describe("session startup catch-up", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-startup-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  async function writeSessionFile(
    name: string,
  ): Promise<{ filePath: string; size: number; mtimeMs: number }> {
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, name);
    await fs.writeFile(
      filePath,
      JSON.stringify({ type: "message", message: { role: "user", content: "startup catchup" } }) +
        "\n",
      "utf-8",
    );
    const stat = await fs.stat(filePath);
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
  }

  it("marks stale indexed session files dirty and schedules catch-up sync", async () => {
    const session = await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([
      {
        path: "sessions/main/thread.jsonl",
        hash: "old-hash",
        mtime: session.mtimeMs - 1000,
        size: session.size,
      },
    ]);

    await expect(harness.catchUp()).resolves.toEqual([session.filePath]);
    expect(harness.getDirtySessionFiles()).toEqual([session.filePath]);
    expect(harness.isSessionsDirty()).toBe(true);
    expect(harness.syncCalls).toEqual([{ reason: "session-startup-catchup" }]);
  });

  it("retries transient session transcript reads during session indexing", async () => {
    const session = await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([]);

    const realOpen = fs.open;
    let attempts = 0;
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof realOpen>) => {
        const [target, flags, mode] = args;
        if (
          typeof target === "string" &&
          path.resolve(target) === session.filePath &&
          attempts++ === 0
        ) {
          const err = new Error(
            "Unknown system error -11: Unknown system error -11, open",
          ) as NodeJS.ErrnoException;
          err.code = "UNKNOWN";
          err.errno = -11;
          throw err;
        }
        return await realOpen(target, flags, mode);
      });

    try {
      await (harness as any).syncSessionFiles({ needsFullReindex: true });
      expect(attempts).toBe(2);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("can mark startup catch-up files without scheduling background sync", async () => {
    const session = await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([
      {
        path: "sessions/main/thread.jsonl",
        hash: "old-hash",
        mtime: session.mtimeMs - 1000,
        size: session.size,
      },
    ]);

    await expect(harness.markStartupDirtyFiles()).resolves.toEqual([session.filePath]);
    expect(harness.getDirtySessionFiles()).toEqual([session.filePath]);
    expect(harness.isSessionsDirty()).toBe(true);
    expect(harness.syncCalls).toEqual([]);
  });

  it("leaves unchanged indexed session files clean", async () => {
    const session = await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([
      {
        path: "sessions/main/thread.jsonl",
        hash: "current-hash",
        mtime: session.mtimeMs,
        size: session.size,
      },
    ]);

    await expect(harness.catchUp()).resolves.toEqual([]);
    expect(harness.getDirtySessionFiles()).toEqual([]);
    expect(harness.isSessionsDirty()).toBe(false);
    expect(harness.syncCalls).toEqual([]);
  });

  it.each([
    {
      name: "read",
      fileName: "delta-read.jsonl",
      failOn: "read" as const,
      code: "EWOULDBLOCK",
    },
    {
      name: "open",
      fileName: "delta-open.jsonl",
      failOn: "open" as const,
      code: "EAGAIN",
    },
  ])("retries transient session transcript $name failures during delta updates", async (params) => {
    const session = await writeSessionFile(params.fileName);
    const harness = new SessionStartupCatchupHarness([]);
    let attempts = 0;
    const sessionBuffer = await fs.readFile(session.filePath);
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const [target] = args;
        if (
          params.failOn === "open" &&
          typeof target === "string" &&
          path.resolve(target) === session.filePath &&
          attempts++ === 0
        ) {
          const err = new Error(
            "Unknown system error -11: Unknown system error -11, open",
          ) as NodeJS.ErrnoException;
          err.code = params.code;
          err.errno = -11;
          throw err;
        }

        return {
          read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
            if (params.failOn === "read" && attempts++ === 0) {
              const err = new Error(
                "Unknown system error -11: Unknown system error -11, read",
              ) as NodeJS.ErrnoException;
              err.code = params.code;
              err.errno = -11;
              throw err;
            }
            const start = position ?? 0;
            const chunk = sessionBuffer.subarray(start, start + length);
            chunk.copy(buffer, offset);
            return { bytesRead: chunk.length, buffer };
          },
          close: async () => {},
        } as unknown as Awaited<ReturnType<typeof fs.open>>;
      });

    try {
      const delta = await (harness as any).updateSessionDelta(session.filePath);
      expect(delta).toMatchObject({
        pendingBytes: session.size,
        pendingMessages: 1,
      });
      expect(attempts).toBe(2);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("does not fall back to full session sync when identity targets normalize away", async () => {
    await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([]);

    await harness.runSyncForTest({
      reason: "queued-sessions",
      sessions: [{ agentId: "other", sessionId: "thread" }],
    });

    expect(harness.indexedPaths).toEqual([]);
  });

  it("does not fall back to full session sync for malformed identity session ids", async () => {
    await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([]);

    await harness.runSyncForTest({
      reason: "queued-sessions",
      sessions: [{ agentId: "main", sessionId: "bad/nested" }],
    });

    expect(harness.indexedPaths).toEqual([]);
  });

  it("resolves identity-targeted delta sync through a custom session store", async () => {
    const storeDir = path.join(stateDir, "custom-sessions");
    const sessionFile = path.join(storeDir, "custom-thread.jsonl");
    const storePath = path.join(storeDir, "sessions.json");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "custom store target" },
      }) + "\n",
      "utf-8",
    );
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:chat:custom": {
          sessionFile: "custom-thread.jsonl",
          sessionId: "custom-thread",
        },
      }),
      "utf-8",
    );
    await fs.writeFile(configPath, JSON.stringify({ session: { store: storePath } }), "utf-8");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    const harness = new SessionStartupCatchupHarness([]);
    (harness as unknown as { settings: ResolvedMemorySearchConfig }).settings.sync.sessions = {
      deltaBytes: 1,
      deltaMessages: 1,
      postCompactionForce: true,
    };
    harness.addPendingSessionTarget({
      agentId: "main",
      sessionId: "custom-thread",
      sessionKey: "agent:main:chat:custom",
    });

    await harness.processPendingSessionDeltas();
    await Promise.resolve();

    expect(harness.getDirtySessionFiles()).toEqual([sessionFile]);
    expect(harness.syncCalls).toEqual([{ reason: "session-delta" }]);
  });

  it("keeps explicit custom-store session file targets at the sync gate", async () => {
    const storeDir = path.join(stateDir, "custom-sessions");
    const sessionFile = path.join(storeDir, "explicit-target.jsonl");
    const storePath = path.join(storeDir, "sessions.json");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "explicit target" },
      }) + "\n",
      "utf-8",
    );
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:chat:explicit-target": {
          sessionFile: "explicit-target.jsonl",
          sessionId: "explicit-target",
        },
      }),
      "utf-8",
    );
    await fs.writeFile(configPath, JSON.stringify({ session: { store: storePath } }), "utf-8");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    const harness = new SessionStartupCatchupHarness([]);

    await expect(
      harness.combineTargetSessionFilesForTest({ sessionFiles: [sessionFile] }),
    ).resolves.toEqual(new Set([sessionFile]));
  });

  it("preserves generated-session classification during targeted custom-store indexing", async () => {
    const storeDir = path.join(stateDir, "custom-sessions");
    const sessionFile = path.join(storeDir, "cron-thread.jsonl");
    const otherSessionFile = path.join(storeDir, "other-thread.jsonl");
    const storePath = path.join(storeDir, "sessions.json");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Internal cron output that must stay out." },
      }) + "\n",
      "utf-8",
    );
    await fs.writeFile(
      otherSessionFile,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Other custom-store content" },
      }) + "\n",
      "utf-8",
    );
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:cron:job-1:run:run-1": {
          sessionFile: "cron-thread.jsonl",
          sessionId: "cron-thread",
        },
        "agent:main:chat:other": {
          sessionFile: "other-thread.jsonl",
          sessionId: "other-thread",
        },
      }),
      "utf-8",
    );
    await fs.writeFile(configPath, JSON.stringify({ session: { store: storePath } }), "utf-8");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    const harness = new SessionStartupCatchupHarness([]);

    await (
      harness as unknown as {
        syncSessionFiles: (params: {
          needsFullReindex: boolean;
          targetSessionFiles: string[];
        }) => Promise<void>;
      }
    ).syncSessionFiles({
      needsFullReindex: false,
      targetSessionFiles: [sessionFile],
    });

    expect(harness.indexedPaths).toEqual(["sessions/cron-thread.jsonl"]);
    expect(harness.indexedContents).toEqual([""]);
  });

  it("queues transcript update identity without requiring a session file", async () => {
    vi.useFakeTimers();
    const harness = new SessionStartupCatchupHarness([]);
    const originalSubscriber = (globalThis as Record<symbol, unknown>)[
      MEMORY_CORE_TRANSCRIPT_UPDATE_SUBSCRIBER_KEY
    ];
    let transcriptListener: ((update: MemorySessionTranscriptUpdate) => void) | undefined;
    (globalThis as Record<symbol, unknown>)[MEMORY_CORE_TRANSCRIPT_UPDATE_SUBSCRIBER_KEY] = ((
      listener,
    ) => {
      transcriptListener = listener;
      return () => {
        if (transcriptListener === listener) {
          transcriptListener = undefined;
        }
      };
    }) satisfies MemoryTranscriptUpdateSubscriber;
    harness.startTranscriptListener();

    try {
      transcriptListener?.({
        target: {
          agentId: "main",
          sessionId: "thread",
          sessionKey: "agent:main:thread",
        },
      });

      expect(harness.getPendingSessionTargets()).toEqual([
        { agentId: "main", sessionId: "thread", sessionKey: "agent:main:thread" },
      ]);
    } finally {
      harness.stopTranscriptListener();
      if (originalSubscriber === undefined) {
        delete (globalThis as Record<symbol, unknown>)[
          MEMORY_CORE_TRANSCRIPT_UPDATE_SUBSCRIBER_KEY
        ];
      } else {
        (globalThis as Record<symbol, unknown>)[MEMORY_CORE_TRANSCRIPT_UPDATE_SUBSCRIBER_KEY] =
          originalSubscriber;
      }
    }
  });

  it("keeps canonical path transcript update compatibility", async () => {
    vi.useFakeTimers();
    const session = await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([]);
    harness.startTranscriptListener();

    emitSessionTranscriptUpdate({
      sessionFile: session.filePath,
      sessionKey: "agent:main:thread",
    });

    expect(harness.getPendingSessionFiles()).toEqual([session.filePath]);
    expect(harness.getPendingSessionTargets()).toEqual([]);
    harness.stopTranscriptListener();
  });

  it("queues file-only transcript updates from a custom session store", async () => {
    vi.useFakeTimers();
    const storeDir = path.join(stateDir, "custom-sessions");
    const sessionFile = path.join(storeDir, "custom-update.jsonl");
    const storePath = path.join(storeDir, "sessions.json");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "custom update" },
      }) + "\n",
      "utf-8",
    );
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:chat:custom-update": {
          sessionFile: "custom-update.jsonl",
          sessionId: "custom-update",
        },
      }),
      "utf-8",
    );
    await fs.writeFile(configPath, JSON.stringify({ session: { store: storePath } }), "utf-8");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    const harness = new SessionStartupCatchupHarness([]);
    harness.startTranscriptListener();

    emitSessionTranscriptUpdate({
      sessionFile,
      sessionKey: "agent:main:chat:custom-update",
    });
    await Promise.resolve();

    expect(harness.getPendingSessionFiles()).toEqual([sessionFile]);
    expect(harness.getPendingSessionTargets()).toEqual([]);
    harness.stopTranscriptListener();
  });

  it("prefers transcript update path compatibility before identity", async () => {
    vi.useFakeTimers();
    const session = await writeSessionFile("thread.jsonl");
    const harness = new SessionStartupCatchupHarness([]);
    harness.startTranscriptListener();

    emitSessionTranscriptUpdate({
      sessionFile: session.filePath,
      target: {
        agentId: "main",
        sessionId: "identity-target",
        sessionKey: "agent:main:identity-target",
      },
    });

    expect(harness.getPendingSessionFiles()).toEqual([session.filePath]);
    expect(harness.getPendingSessionTargets()).toEqual([]);
    harness.stopTranscriptListener();
  });
});
