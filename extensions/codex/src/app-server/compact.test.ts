import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { maybeCompactCodexAppServerSession, __testing } from "./compact.js";
import type { CodexServerNotification } from "./protocol.js";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.js";

let tempDir: string;

function testSessionId(suffix = "session-1"): string {
  return suffix;
}

async function writeTestBinding(options: { authProfileId?: string } = {}): Promise<string> {
  const sessionId = testSessionId();
  await writeCodexAppServerBinding(
    { sessionKey: "agent:main:session-1", sessionId },
    {
      threadId: "thread-1",
      cwd: tempDir,
      ...options,
    },
  );
  return sessionId;
}

function startCompaction(sessionId: string, options: { currentTokenCount?: number } = {}) {
  return maybeCompactCodexAppServerSession({
    sessionKey: "agent:main:session-1",
    sessionId,
    workspaceDir: tempDir,
    ...options,
  });
}

describe("maybeCompactCodexAppServerSession", () => {
  beforeEach(async () => {
    await clearCodexAppServerBinding({ sessionKey: "agent:main:session-1" });
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-compact-"));
  });

  afterEach(async () => {
    await clearCodexAppServerBinding({ sessionKey: "agent:main:session-1" });
    __testing.resetCodexAppServerClientFactoryForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("waits for native app-server compaction before reporting success", async () => {
    const fake = createFakeCodexClient();
    __testing.setCodexAppServerClientFactoryForTests(async () => fake.client);
    const sessionId = await writeTestBinding();

    const pendingResult = startCompaction(sessionId, { currentTokenCount: 123 });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });

    let settled = false;
    void pendingResult.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    const result = await pendingResult;

    expect(result).toMatchObject({
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 123,
        details: {
          backend: "codex-app-server",
          threadId: "thread-1",
          signal: "thread/compacted",
          turnId: "turn-1",
        },
      },
    });
  });

  it("accepts native context-compaction item completion as success", async () => {
    const fake = createFakeCodexClient();
    __testing.setCodexAppServerClientFactoryForTests(async () => fake.client);
    const sessionId = await writeTestBinding();

    const pendingResult = startCompaction(sessionId);
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "contextCompaction", id: "compact-1" },
      },
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: true,
      compacted: true,
      result: {
        details: {
          signal: "item/completed",
          itemId: "compact-1",
        },
      },
    });
  });

  it("reuses the bound auth profile for native compaction", async () => {
    const fake = createFakeCodexClient();
    let seenAuthProfileId: string | undefined;
    __testing.setCodexAppServerClientFactoryForTests(async (_startOptions, authProfileId) => {
      seenAuthProfileId = authProfileId;
      return fake.client;
    });
    const sessionId = await writeTestBinding({ authProfileId: "openai-codex:work" });

    const pendingResult = startCompaction(sessionId);
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await pendingResult;

    expect(seenAuthProfileId).toBe("openai-codex:work");
  });

  it("looks up native compaction bindings by OpenClaw session key", async () => {
    const fake = createFakeCodexClient();
    __testing.setCodexAppServerClientFactoryForTests(async () => fake.client);
    const sessionId = await writeTestBinding();
    await expect(readCodexAppServerBinding(sessionId)).resolves.toBeUndefined();

    const pendingResult = startCompaction(sessionId);
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: true,
      compacted: true,
    });
  });

  it("fails closed when the persisted binding auth profile disagrees with the runtime request", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    __testing.setCodexAppServerClientFactoryForTests(factory);
    const sessionId = testSessionId("auth-profile-mismatch");
    await writeCodexAppServerBinding(
      { sessionKey: "agent:main:session-1", sessionId },
      {
        threadId: "thread-1",
        cwd: tempDir,
        authProfileId: "openai-codex:binding",
      },
    );

    const result = await maybeCompactCodexAppServerSession({
      sessionKey: "agent:main:session-1",
      sessionId,
      workspaceDir: tempDir,
      authProfileId: "openai-codex:runtime",
    });

    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason: "auth profile mismatch for session binding",
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("prefers owning context-engine compaction and records native status separately", async () => {
    const fake = createFakeCodexClient();
    __testing.setCodexAppServerClientFactoryForTests(async () => fake.client);
    const sessionId = await writeTestBinding();
    const maintain = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn(async () => ({
        ok: true,
        compacted: true,
        result: {
          summary: "engine summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 55,
          details: { engine: "lossless-claw" },
        },
      })),
      maintain,
    };

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionKey: "agent:main:session-1",
      sessionId,
      workspaceDir: tempDir,
      contextEngine,
      contextTokenBudget: 777,
      contextEngineRuntimeContext: { workspaceDir: tempDir, provider: "codex" },
      currentTokenCount: 123,
      trigger: "manual",
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 55,
        details: {
          engine: "lossless-claw",
          codexNativeCompaction: {
            ok: true,
            compacted: true,
            details: {
              backend: "codex-app-server",
              threadId: "thread-1",
            },
          },
        },
      },
    });
    expect(contextEngine.compact).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenBudget: 777,
        currentTokenCount: 123,
        compactionTarget: "threshold",
        force: true,
        runtimeContext: expect.objectContaining({
          workspaceDir: tempDir,
          provider: "codex",
        }),
      }),
    );
    expect(maintain).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: expect.objectContaining({
          workspaceDir: tempDir,
          provider: "codex",
        }),
      }),
    );
  });

  it("still runs native compaction when context-engine maintenance fails", async () => {
    const fake = createFakeCodexClient();
    __testing.setCodexAppServerClientFactoryForTests(async () => fake.client);
    const sessionId = await writeTestBinding();
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn(async () => ({
        ok: true,
        compacted: true,
        result: {
          summary: "engine summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 55,
        },
      })),
      maintain: vi.fn(async () => {
        throw new Error("maintenance boom");
      }),
    };

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionKey: "agent:main:session-1",
      sessionId,
      workspaceDir: tempDir,
      contextEngine,
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: true,
      compacted: true,
      result: {
        details: {
          codexNativeCompaction: {
            ok: true,
            compacted: true,
          },
        },
      },
    });
  });

  it("records native compaction status when primary compaction has no result payload", async () => {
    const fake = createFakeCodexClient();
    __testing.setCodexAppServerClientFactoryForTests(async () => fake.client);
    const sessionId = await writeTestBinding();
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn(async () => ({
        ok: true,
        compacted: false,
        reason: "below threshold",
      })),
    };

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionKey: "agent:main:session-1",
      sessionId,
      workspaceDir: tempDir,
      contextEngine,
      currentTokenCount: 222,
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: true,
      compacted: false,
      reason: "below threshold",
      result: {
        tokensBefore: 222,
        details: {
          codexNativeCompaction: {
            ok: true,
            compacted: true,
          },
        },
      },
    });
  });

  it("reports context-engine compaction errors without skipping native compaction", async () => {
    const fake = createFakeCodexClient();
    __testing.setCodexAppServerClientFactoryForTests(async () => fake.client);
    const sessionId = await writeTestBinding();
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn(async () => {
        throw new Error("engine boom");
      }),
    };

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionKey: "agent:main:session-1",
      sessionId,
      workspaceDir: tempDir,
      contextEngine,
      currentTokenCount: 222,
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      compacted: true,
      reason: "context engine compaction failed: engine boom",
      result: {
        details: {
          contextEngineCompaction: {
            ok: false,
            reason: "context engine compaction failed: engine boom",
          },
          codexNativeCompaction: {
            ok: true,
            compacted: true,
          },
        },
      },
    });
  });

  it("does not fail owning context-engine compaction when Codex native compaction cannot run", async () => {
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn(async () => ({
        ok: true,
        compacted: true,
        result: {
          summary: "engine summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 8,
        },
      })),
    };

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionId: "missing-binding",
      workspaceDir: tempDir,
      contextEngine,
    });

    expect(result).toMatchObject({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        details: {
          codexNativeCompaction: {
            ok: false,
            compacted: false,
            reason: "no codex app-server thread binding",
          },
        },
      },
    });
  });
});

function createFakeCodexClient(): {
  client: CodexAppServerClient;
  request: ReturnType<typeof vi.fn>;
  emit: (notification: CodexServerNotification) => void;
} {
  const handlers = new Set<(notification: CodexServerNotification) => void>();
  const request = vi.fn(async () => ({}));
  return {
    client: {
      request,
      addNotificationHandler(handler: (notification: CodexServerNotification) => void) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    } as unknown as CodexAppServerClient,
    request,
    emit(notification: CodexServerNotification): void {
      for (const handler of handlers) {
        handler(notification);
      }
    },
  };
}
