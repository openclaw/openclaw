/**
 * L2 — Task Persistence & Recovery Live Integration Test
 *
 * Tests the full cycle:
 *   1. Submit a real financial analysis via ExpertManager (with TaskStore)
 *   2. Verify task is persisted to SQLite
 *   3. Wait for completion (SSE relay)
 *   4. Verify SQLite status updated to "completed"
 *   5. Simulate restart: create a fresh ExpertManager, call recoverTasks()
 *      on a "running" row, verify it polls thread state and resolves
 *
 * Run: LIVE=1 npx vitest run extensions/findoo-alpha-plugin/test/recovery-live.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, afterAll } from "vitest";
import { ExpertManager } from "../src/expert-manager.js";
import { LangGraphClient } from "../src/langgraph-client.js";
import { TaskStore } from "../src/task-store.js";

const SKIP = !process.env.LIVE;
const STRATEGY_AGENT_URL = process.env.STRATEGY_AGENT_URL ?? "http://43.128.100.43:5085";
const ASSISTANT_ID = process.env.STRATEGY_ASSISTANT_ID ?? "d2310a07-b552-453c-a8bb-7b9b86de6b23";

// Shared state across sequential tests
let tmpDir: string;
let dbPath: string;
let taskStore: TaskStore;
let client: LangGraphClient;
let manager: ExpertManager;
let submittedTaskId: string;
let submittedThreadId: string;

const systemEvents: Array<{ text: string; opts: Record<string, unknown> }> = [];
const heartbeats: Array<Record<string, unknown>> = [];

const log = {
  info: (msg: string) => console.log(`  [info] ${msg}`),
  warn: (msg: string) => console.log(`  [warn] ${msg}`),
  error: (msg: string) => console.log(`  [error] ${msg}`),
};

describe.skipIf(SKIP)("L2 — Task Persistence & Recovery", { timeout: 300_000 }, () => {
  afterAll(() => {
    manager?.dispose();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1. setup — health check passes", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "alpha-recovery-test-"));
    dbPath = join(tmpDir, "tasks.sqlite");
    taskStore = new TaskStore(dbPath);
    client = new LangGraphClient(STRATEGY_AGENT_URL, ASSISTANT_ID);

    const ok = await client.healthCheck();
    expect(ok).toBe(true);

    manager = new ExpertManager({
      client,
      assistantId: ASSISTANT_ID,
      enqueueSystemEvent: (text, opts) => systemEvents.push({ text, opts }),
      requestHeartbeatNow: (opts) => heartbeats.push(opts ?? {}),
      logger: log,
      maxConcurrentTasks: 5,
      taskStore,
    });
    manager.setHealthy(true);
  });

  it("2. submit — real financial analysis persisted to SQLite", async () => {
    const result = await manager.submit({
      query: "简要分析贵州茅台(600519)当前估值水平",
      context: { symbol: "600519.SS", market: "cn" },
      sessionKey: "agent:main:test-recovery",
    });

    submittedTaskId = result.taskId;
    submittedThreadId = result.threadId;

    expect(result.taskId).toMatch(/^fa-/);
    expect(result.threadId).toBeDefined();
    expect(result.label).toContain("茅台");

    // Verify persisted in SQLite
    const row = taskStore.findByTaskId(submittedTaskId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("running");
    expect(row!.threadId).toBe(submittedThreadId);

    console.log(`  [submit] taskId=${submittedTaskId} threadId=${submittedThreadId}`);
  });

  it("3. wait — relay completes and SQLite status updates", async () => {
    // Poll SQLite until status changes (max 240s — some analyses take 2-3 min)
    const deadline = Date.now() + 240_000;
    let finalRow = taskStore.findByTaskId(submittedTaskId);

    while (finalRow?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      finalRow = taskStore.findByTaskId(submittedTaskId);
    }

    expect(finalRow).not.toBeNull();
    expect(finalRow!.status).toBe("completed");
    expect(finalRow!.completedAt).toBeGreaterThan(0);

    console.log(
      `  [completed] elapsed=${Math.round((finalRow!.completedAt! - finalRow!.submittedAt) / 1000)}s`,
    );

    // SystemEvents should have been emitted during relay
    expect(systemEvents.length).toBeGreaterThan(0);
    console.log(`  [events] ${systemEvents.length} system events emitted`);
  });

  it("4. recovery — simulate restart, recover completed task from thread state", async () => {
    // Dispose original manager (closes taskStore)
    manager.dispose();

    // Directly reset the task to "running" via raw SQLite to simulate a crash
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec("PRAGMA journal_mode = WAL");
    rawDb
      .prepare("UPDATE alpha_tasks SET status = 'running', completed_at = NULL WHERE task_id = ?")
      .run(submittedTaskId);
    rawDb.close();

    // Create a fresh TaskStore + ExpertManager (simulates gateway restart)
    const taskStore2 = new TaskStore(dbPath);
    const row = taskStore2.findByTaskId(submittedTaskId);
    expect(row!.status).toBe("running");

    const recoveryEvents: Array<{ text: string; opts: Record<string, unknown> }> = [];
    const recoveryHeartbeats: Array<Record<string, unknown>> = [];

    const manager2 = new ExpertManager({
      client,
      assistantId: ASSISTANT_ID,
      enqueueSystemEvent: (text, opts) => recoveryEvents.push({ text, opts }),
      requestHeartbeatNow: (opts) => recoveryHeartbeats.push(opts ?? {}),
      logger: log,
      maxConcurrentTasks: 5,
      taskStore: taskStore2,
    });

    // Trigger recovery
    await manager2.recoverTasks();

    // Wait for recovery polling to complete (max 30s — task already completed on server)
    const deadline = Date.now() + 30_000;
    let recovered = taskStore2.findByTaskId(submittedTaskId);

    while (recovered?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      recovered = taskStore2.findByTaskId(submittedTaskId);
    }

    expect(recovered).not.toBeNull();
    expect(recovered!.status).toBe("completed");

    // Recovery should have emitted a SystemEvent with the result
    const doneEvent = recoveryEvents.find((e) => e.text.includes("分析完成"));
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.text).toContain("恢复");

    // HeartbeatWake should have been triggered with exec-event
    const execEvent = recoveryHeartbeats.find(
      (h) => (h as Record<string, string>).reason === "exec-event",
    );
    expect(execEvent).toBeDefined();

    console.log(`  [recovery] task recovered successfully`);
    console.log(`  [recovery] result: ${doneEvent!.text.slice(0, 200)}...`);
    console.log(
      `  [recovery] ${recoveryEvents.length} events, ${recoveryHeartbeats.length} heartbeats`,
    );

    manager2.dispose();
  });
});
