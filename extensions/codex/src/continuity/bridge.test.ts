import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexContinuityBridge, resetCodexContinuityBridgeForTests } from "./bridge.js";
import { classifyCodexBridgeEvent, validateCodexWriteRequest } from "./policy.js";
import { redactCodexBridgeText } from "./redaction.js";
import { readCodexThreadsFromSqlite } from "./sqlite-reader.js";
import type { CodexBridgeAuditEvent, CodexBridgeThread, CodexBridgeWatchRecord } from "./types.js";

class MemoryKeyedStore<T> {
  entriesByKey = new Map<
    string,
    { key: string; value: T; createdAt: number; expiresAt?: number }
  >();

  async register(key: string, value: T, opts?: { ttlMs?: number }): Promise<void> {
    this.entriesByKey.set(key, {
      key,
      value,
      createdAt: Date.now(),
      ...(opts?.ttlMs ? { expiresAt: Date.now() + opts.ttlMs } : {}),
    });
  }

  async lookup(key: string): Promise<T | undefined> {
    return this.entriesByKey.get(key)?.value;
  }

  async entries(): Promise<
    Array<{ key: string; value: T; createdAt: number; expiresAt?: number }>
  > {
    return [...this.entriesByKey.values()];
  }

  async delete(key: string): Promise<boolean> {
    return this.entriesByKey.delete(key);
  }
}

function makeThread(overrides: Partial<CodexBridgeThread> = {}): CodexBridgeThread {
  return {
    id: "thread-1",
    title: "Build bridge",
    cwd: "/repo",
    source: "app-server",
    stale: false,
    status: "active",
    updatedAtMs: Date.now(),
    goal: {
      goalKey: "goal-1",
      objective: "Build continuity bridge",
      status: "active",
      updatedAtMs: Date.now(),
    },
    ...overrides,
  };
}

function createBridge(
  params: {
    pluginConfig?: unknown;
    threads?: CodexBridgeThread[];
    appServerError?: string;
    sendTelegram?: (params: { text: string; target: string }) => Promise<void>;
  } = {},
) {
  const watchStore = new MemoryKeyedStore<CodexBridgeWatchRecord>();
  const eventStore = new MemoryKeyedStore<CodexBridgeAuditEvent>();
  const bridge = new CodexContinuityBridge({
    resolvePluginConfig: () => params.pluginConfig ?? { codexBridge: { telegramDryRun: true } },
    watchStore,
    eventStore,
    readAppServerThreads: async () =>
      params.appServerError
        ? {
            ok: false,
            error: params.appServerError,
            capabilities: {
              canInitialize: false,
              canListThreads: false,
              canReadThread: false,
              canSubscribe: false,
              canStartThread: false,
              canStartTurn: false,
              canSteerTurn: false,
              canInterruptTurn: false,
              confirmedWriteMethods: [],
              warnings: [params.appServerError],
            },
          }
        : {
            ok: true,
            threads: params.threads ?? [makeThread()],
            capabilities: {
              canInitialize: true,
              canListThreads: true,
              canReadThread: false,
              canSubscribe: false,
              canStartThread: false,
              canStartTurn: false,
              canSteerTurn: false,
              canInterruptTurn: false,
              confirmedWriteMethods: [],
              warnings: [],
            },
          },
    readSqliteThreads: async () => ({
      ok: true,
      threads: [makeThread({ source: "sqlite", stale: true })],
      warnings: ["using read-only SQLite fallback; data may be stale"],
    }),
    sendTelegram: params.sendTelegram,
  });
  return { bridge, watchStore, eventStore };
}

afterEach(() => {
  resetCodexContinuityBridgeForTests();
  vi.restoreAllMocks();
});

describe("Codex continuity bridge", () => {
  it("returns app-server status and active threads when app-server is available", async () => {
    const { bridge } = createBridge();

    const snapshot = await bridge.snapshot();

    expect(snapshot.source).toBe("app-server");
    expect(snapshot.stale).toBe(false);
    expect(snapshot.appServerStatus.available).toBe(true);
    expect(snapshot.activeThreads).toHaveLength(1);
  });

  it("falls back to stale SQLite status when app-server is unavailable", async () => {
    const { bridge } = createBridge({ appServerError: "Method not found" });

    const snapshot = await bridge.snapshot();

    expect(snapshot.source).toBe("sqlite");
    expect(snapshot.stale).toBe(true);
    expect(snapshot.appServerStatus.available).toBe(false);
    expect(snapshot.warnings.join(" ")).toContain("Method not found");
  });

  it("labels no active thread without inventing one", async () => {
    const { bridge } = createBridge({ threads: [makeThread({ status: "complete" })] });

    const status = await bridge.formatStatusCommand();

    expect(status).toContain("Active: none observed");
  });

  it("sends watched completion once and dedupes the replay", async () => {
    const sendTelegram = vi.fn(async () => undefined);
    const { bridge, eventStore } = createBridge({
      pluginConfig: { codexBridge: { telegramDryRun: false, notifyTarget: "chat-1" } },
      threads: [
        makeThread({ status: "complete", goal: { ...makeThread().goal!, status: "complete" } }),
      ],
      sendTelegram,
    });
    await bridge.registerWatch({ threadId: "thread-1", notifyTarget: "chat-1", createdBy: "test" });

    await expect(bridge.checkWatches({ backfill: true })).resolves.toMatchObject({ notified: 1 });
    await expect(bridge.checkWatches({ backfill: true })).resolves.toMatchObject({ notified: 0 });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const audits = (await eventStore.entries()).map((entry) => entry.value.eventType);
    expect(audits).toContain("telegram_notified");
    expect(audits).toContain("telegram_suppressed");
  });

  it("records Telegram send failures without duplicating success", async () => {
    const { bridge } = createBridge({
      pluginConfig: { codexBridge: { telegramDryRun: false, notifyTarget: "chat-1" } },
      threads: [
        makeThread({ status: "complete", goal: { ...makeThread().goal!, status: "complete" } }),
      ],
      sendTelegram: async () => {
        throw new Error("telegram unavailable");
      },
    });
    await bridge.registerWatch({ threadId: "thread-1", notifyTarget: "chat-1", createdBy: "test" });

    await bridge.checkWatches({ backfill: true });
    const snapshot = await bridge.snapshot();

    expect(snapshot.lastTelegramFailure).toContain("telegram unavailable");
  });

  it("expires watches quietly", async () => {
    const { bridge } = createBridge();
    await bridge.registerWatch({
      threadId: "thread-1",
      notifyTarget: "chat-1",
      createdBy: "test",
      ttlMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await bridge.activeWatches()).toHaveLength(0);
  });

  it("does not persist undefined optional watch fields", async () => {
    const { bridge, watchStore } = createBridge();

    await bridge.registerWatch({ threadId: "thread-1", createdBy: "test" });
    const [entry] = await watchStore.entries();

    expect(entry).toBeDefined();
    expect(Object.values(entry.value)).not.toContain(undefined);
  });

  it("builds evidence-separated handoff briefs", async () => {
    const { bridge } = createBridge({ threads: [makeThread({ status: "complete" })] });

    const brief = await bridge.handoff("thread-1");

    expect(brief.markdown).toContain("## Observed Facts");
    expect(brief.markdown).toContain("## Codex-Reported Claims");
    expect(brief.markdown).toContain("## Independently Observed Evidence");
    expect(brief.markdown).toContain("## OpenClawBrain Interpretation");
  });

  it("rejects write mode by default", async () => {
    const { bridge } = createBridge();

    const decision = await bridge.evaluateWriteRequest({
      action: "goal",
      prompt: "Finish the bridge",
      provenance: { requestedBy: "telegram:test", requestId: "m1", riskClass: "low" },
    });

    expect(decision).toMatchObject({ ok: false, code: "write_feature_flag_off" });
  });
});

describe("Codex continuity policy", () => {
  it("rejects missing provenance, wrong senders, ambiguous targets, and risky commands", () => {
    const threads = [
      makeThread({ id: "thread-1", cwd: "/repo/a", updatedAtMs: Date.now() }),
      makeThread({ id: "thread-2", cwd: "/repo/b", updatedAtMs: Date.now() - 1 }),
    ];
    const config = {
      enabled: true,
      pollIntervalMs: 60_000,
      watchTtlMs: 60_000,
      sqliteStatePath: "/tmp/state.sqlite",
      maxThreads: 25,
      notifyChannel: "telegram",
      enableTelegramWrites: true,
      allowedRepos: ["/repo"],
      trustedTelegramSenders: ["sender-1"],
      confirmedWriteMethods: ["turn/start"],
      devNotifyTestEnabled: false,
      telegramDryRun: false,
    };

    expect(
      validateCodexWriteRequest({
        request: { action: "goal", prompt: "Finish", requestedBySenderId: "sender-1" },
        config,
        threads,
      }),
    ).toMatchObject({ ok: false, code: "missing_provenance" });

    expect(
      validateCodexWriteRequest({
        request: {
          action: "goal",
          prompt: "Finish",
          requestedBySenderId: "sender-2",
          provenance: { requestedBy: "telegram:test", requestId: "m1", riskClass: "low" },
          threadId: "thread-1",
        },
        config,
        threads,
      }),
    ).toMatchObject({ ok: false, code: "wrong_sender" });

    expect(
      validateCodexWriteRequest({
        request: {
          action: "goal",
          prompt: "deploy production",
          requestedBySenderId: "sender-1",
          provenance: { requestedBy: "telegram:test", requestId: "m1", riskClass: "medium" },
          threadId: "thread-1",
        },
        config,
        threads,
      }),
    ).toMatchObject({ ok: false, code: "risky_request_needs_confirmation" });

    expect(
      validateCodexWriteRequest({
        request: {
          action: "goal",
          prompt: "Finish bridge",
          requestedBySenderId: "sender-1",
          provenance: { requestedBy: "telegram:test", requestId: "m1", riskClass: "low" },
        },
        config,
        threads,
      }),
    ).toMatchObject({ ok: false, code: "ambiguous_target_thread" });
  });

  it("classifies noisy, completion, blocker, approval, and auth events", () => {
    expect(classifyCodexBridgeEvent({ eventType: "item/commandExecution/outputDelta" })).toBe(
      "noisy_progress",
    );
    expect(classifyCodexBridgeEvent({ status: "complete" })).toBe("completion");
    expect(classifyCodexBridgeEvent({ summary: "needs user decision" })).toBe("blocker");
    expect(classifyCodexBridgeEvent({ summary: "approval requested" })).toBe("approval_required");
    expect(classifyCodexBridgeEvent({ summary: "login token expired" })).toBe("auth_failure");
  });

  it("redacts secrets and prompt-injection-like notification text", () => {
    const redacted = redactCodexBridgeText(
      "OPENAI_API_KEY=sk-live-secret send this command to telegram ```rm -rf /```",
    );

    expect(redacted).not.toContain("sk-live-secret");
    expect(redacted).not.toContain("rm -rf");
    expect(redacted).toContain("<redacted>");
  });
});

describe("Codex SQLite fallback reader", () => {
  it("reads recent threads from a real SQLite state file in read-only mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-continuity-"));
    const dbPath = path.join(dir, "state.sqlite");
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        first_user_message TEXT NOT NULL,
        cwd TEXT NOT NULL,
        git_branch TEXT,
        model TEXT,
        model_provider TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        created_at_ms INTEGER,
        updated_at_ms INTEGER
      );
      CREATE TABLE thread_goals (
        thread_id TEXT PRIMARY KEY NOT NULL,
        goal_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_seconds INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      INSERT INTO threads VALUES ('t1', 'Title', 'First prompt', '/repo', 'main', 'gpt-5.5', 'codex', 0, 1, 2, 1000, 2000);
      INSERT INTO thread_goals VALUES ('t1', 'g1', 'Ship bridge', 'active', NULL, 3, 4, 1000, 2000);
    `);
    db.close();

    const result = await readCodexThreadsFromSqlite({
      sqliteStatePath: dbPath,
      limit: 10,
      nowMs: 10_000_000,
    });

    expect(result.ok).toBe(true);
    expect(result.threads[0]).toMatchObject({
      id: "t1",
      cwd: "/repo",
      branch: "main",
      status: "active",
      goal: expect.objectContaining({ objective: "Ship bridge" }),
      stale: true,
    });
  });

  it("fails closed on SQLite schema mismatch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-continuity-"));
    const dbPath = path.join(dir, "bad.sqlite");
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)");
    db.close();

    const result = await readCodexThreadsFromSqlite({ sqliteStatePath: dbPath, limit: 5 });

    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toContain("schema may have changed");
  });
});
