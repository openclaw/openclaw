import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  embeddedAgentLog,
  type HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClientFactory } from "./client-factory.js";
import type { CodexAppServerClient } from "./client.js";
import { maybeCompactCodexAppServerSession as maybeCompactCodexAppServerSessionImpl } from "./compact.js";
import type { CodexServerNotification } from "./protocol.js";
import { writeCodexAppServerBinding } from "./session-binding.js";

let tempDir: string;
let codexAppServerClientFactoryForTest: CodexAppServerClientFactory | undefined;

type MaybeCompactOptions = NonNullable<Parameters<typeof maybeCompactCodexAppServerSessionImpl>[1]>;

function setCodexAppServerClientFactoryForTest(factory: CodexAppServerClientFactory): void {
  codexAppServerClientFactoryForTest = factory;
}

function resetCodexAppServerClientFactoryForTest(): void {
  codexAppServerClientFactoryForTest = undefined;
}

function maybeCompactCodexAppServerSession(
  params: Parameters<typeof maybeCompactCodexAppServerSessionImpl>[0],
  options: MaybeCompactOptions = {},
) {
  const clientFactory = options.clientFactory ?? codexAppServerClientFactoryForTest;
  return maybeCompactCodexAppServerSessionImpl(
    params,
    clientFactory ? { ...options, clientFactory } : options,
  );
}

async function writeTestBinding(options: { authProfileId?: string } = {}): Promise<string> {
  const sessionFile = path.join(tempDir, "session.jsonl");
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-1",
    cwd: tempDir,
    ...options,
  });
  return sessionFile;
}

function startCompaction(sessionFile: string, options: { currentTokenCount?: number } = {}) {
  return maybeCompactCodexAppServerSession({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    ...options,
  });
}

type CompactResult = NonNullable<Awaited<ReturnType<typeof maybeCompactCodexAppServerSession>>>;

function requireCompactResult(result: CompactResult | undefined): CompactResult {
  if (!result) {
    throw new Error("expected compaction result");
  }
  return result;
}

function compactDetails(result: CompactResult): Record<string, unknown> {
  return (result.result?.details ?? {}) as Record<string, unknown>;
}

describe("maybeCompactCodexAppServerSession", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-compact-"));
  });

  afterEach(async () => {
    resetCodexAppServerClientFactoryForTest();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("waits for native app-server compaction before reporting success", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = startCompaction(sessionFile, { currentTokenCount: 123 });
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
    const result = requireCompactResult(await pendingResult);

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.tokensBefore).toBe(123);
    const details = compactDetails(result);
    expect(details.backend).toBe("codex-app-server");
    expect(details.threadId).toBe("thread-1");
    expect(details.signal).toBe("thread/compacted");
    expect(details.turnId).toBe("turn-1");
  });

  it("accepts native context-compaction item completion as success", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = startCompaction(sessionFile);
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

    const result = requireCompactResult(await pendingResult);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    const details = compactDetails(result);
    expect(details.signal).toBe("item/completed");
    expect(details.itemId).toBe("compact-1");
  });

  it("reuses the bound auth profile for native compaction", async () => {
    const fake = createFakeCodexClient();
    let seenAuthProfileId: string | undefined;
    setCodexAppServerClientFactoryForTest(async (_startOptions, authProfileId) => {
      seenAuthProfileId = authProfileId;
      return fake.client;
    });
    const sessionFile = await writeTestBinding({ authProfileId: "openai-codex:work" });

    const pendingResult = startCompaction(sessionFile);
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

  it("warns when stale OpenClaw compaction overrides are ignored", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
      workspaceDir: tempDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
            },
          },
        },
      },
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await pendingResult;

    expect(warn).toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        ignoredConfig: ["agents.defaults.compaction.model", "agents.defaults.compaction.provider"],
      },
    );
    warn.mockRestore();
  });

  it("warns when active agent compaction overrides are ignored", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:nik:session-1",
      sessionFile,
      workspaceDir: tempDir,
      config: {
        agents: {
          list: [
            {
              id: "nik",
              compaction: {
                model: "openai/gpt-5.4-mini",
                provider: "openai",
              },
            },
          ],
        },
      },
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await pendingResult;

    expect(warn).toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      {
        sessionId: "session-1",
        sessionKey: "agent:nik:session-1",
        ignoredConfig: ["agents.list.nik.compaction.model", "agents.list.nik.compaction.provider"],
      },
    );
    warn.mockRestore();
  });

  it("reports inherited compaction providers at the source path", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:nik:session-1",
      sessionFile,
      workspaceDir: tempDir,
      config: {
        agents: {
          defaults: {
            compaction: {
              provider: "custom-summary",
            },
          },
          list: [
            {
              id: "nik",
              compaction: {
                model: "openai/gpt-5.4-mini",
              },
            },
          ],
        },
      },
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await pendingResult;

    expect(warn).toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      {
        sessionId: "session-1",
        sessionKey: "agent:nik:session-1",
        ignoredConfig: ["agents.defaults.compaction.provider", "agents.list.nik.compaction.model"],
      },
    );
    warn.mockRestore();
  });

  it("does not warn for legacy Lossless config when the Lossless context engine slot is active", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();
    const contextEngine: ContextEngine = {
      info: { id: "lcm", name: "Lossless Context Manager", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn() as never,
    };

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
      workspaceDir: tempDir,
      contextEngine,
      config: {
        plugins: {
          slots: {
            contextEngine: "lossless-claw",
          },
        },
        agents: {
          defaults: {
            compaction: {
              model: "openai/gpt-5.4",
              provider: "lossless-claw",
            },
          },
        },
      },
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await pendingResult;

    expect(warn).not.toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("does not warn for inherited legacy Lossless provider when the Lossless slot is active", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();
    const contextEngine: ContextEngine = {
      info: { id: "lcm", name: "Lossless Context Manager", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn() as never,
    };

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:nik:session-1",
      sessionFile,
      workspaceDir: tempDir,
      contextEngine,
      config: {
        plugins: {
          slots: {
            contextEngine: "lossless-claw",
          },
        },
        agents: {
          defaults: {
            compaction: {
              provider: "lossless-claw",
            },
          },
          list: [
            {
              id: "nik",
              compaction: {
                model: "openai/gpt-5.4-mini",
              },
            },
          ],
        },
      },
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await pendingResult;

    expect(warn).not.toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("fails closed when the persisted binding auth profile disagrees with the runtime request", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    setCodexAppServerClientFactoryForTest(factory);
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      authProfileId: "openai-codex:binding",
    });

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
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

  it("keeps context engines in maintenance mode after native compaction", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 55,
        details: { engine: "lossless-claw" },
      },
    }));
    const maintain = vi.fn(
      async (_params: Parameters<NonNullable<ContextEngine["maintain"]>>[0]) => ({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
      }),
    );
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact,
      maintain,
    };

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
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

    const result = requireCompactResult(await pendingResult);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.summary).toBe("");
    expect(result.result?.firstKeptEntryId).toBe("");
    expect(result.result?.tokensBefore).toBe(123);
    const details = compactDetails(result);
    expect(details.backend).toBe("codex-app-server");
    expect(details.threadId).toBe("thread-1");
    expect(details.signal).toBe("thread/compacted");
    expect(details.turnId).toBe("turn-1");
    expect(compact).not.toHaveBeenCalled();
    expect(maintain).toHaveBeenCalledTimes(1);
    const [maintainCall] = maintain.mock.calls[0] ?? [];
    const maintainParams = maintainCall as
      | {
          sessionId?: string;
          sessionKey?: string;
          sessionFile?: string;
          runtimeContext?: { workspaceDir?: string; provider?: string };
        }
      | undefined;
    expect(maintainParams?.sessionId).toBe("session-1");
    expect(maintainParams?.sessionKey).toBe("agent:main:session-1");
    expect(maintainParams?.sessionFile).toBe(sessionFile);
    expect(maintainParams?.runtimeContext?.workspaceDir).toBe(tempDir);
    expect(maintainParams?.runtimeContext?.provider).toBe("codex");
  });

  it("returns native compaction success when context-engine maintenance fails", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 55,
      },
    }));
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact,
      maintain: vi.fn(async () => {
        throw new Error("maintenance boom");
      }),
    };

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
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

    const result = requireCompactResult(await pendingResult);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    const details = compactDetails(result);
    expect(details.backend).toBe("codex-app-server");
    expect(details.threadId).toBe("thread-1");
    expect(compact).not.toHaveBeenCalled();
  });

  it("does not fall back to context-engine compaction when native compaction cannot run", async () => {
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 8,
      },
    }));
    const maintain = vi.fn(async () => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact,
      maintain,
    };

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: path.join(tempDir, "missing-binding.jsonl"),
      workspaceDir: tempDir,
      contextEngine,
    });

    const compactResult = requireCompactResult(result);
    expect(compactResult.ok).toBe(false);
    expect(compactResult.compacted).toBe(false);
    expect(compactResult.reason).toBe("no codex app-server thread binding");
    expect(compact).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
  });

  it("does not run context-engine maintenance when native compaction is skipped", async () => {
    const maintain = vi.fn(async () => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn(async () => ({
        ok: true,
        compacted: true,
      })),
      maintain,
    };

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: path.join(tempDir, "missing-binding.jsonl"),
      workspaceDir: tempDir,
      contextEngine,
    });

    const compactResult = requireCompactResult(result);
    expect(compactResult.ok).toBe(false);
    expect(compactResult.compacted).toBe(false);
    expect(maintain).not.toHaveBeenCalled();
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
