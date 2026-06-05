import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, type SessionEntry } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "./internal-runtime-context.js";
import {
  markRestartAbortedMainSessions,
  markRestartAbortedMainSessionsFromLocks,
  recoverRestartAbortedMainSessions,
} from "./main-session-restart-recovery.js";
import type { SessionLockInspection } from "./session-write-lock.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

// Default to the real transcript-append implementation; individual tests can
// override appendInjectedAssistantMessageToTranscript to exercise the not-ok path.
const transcriptAppendOverride: {
  current:
    | ((params: { transcriptPath: string }) => Promise<{ ok: boolean; error?: string }>)
    | null;
} = { current: null };

vi.mock("../gateway/server-methods/chat-transcript-inject.js", async () => {
  const actual = await vi.importActual<
    typeof import("../gateway/server-methods/chat-transcript-inject.js")
  >("../gateway/server-methods/chat-transcript-inject.js");
  return {
    ...actual,
    appendInjectedAssistantMessageToTranscript: (params: { transcriptPath: string }) =>
      (transcriptAppendOverride.current ?? actual.appendInjectedAssistantMessageToTranscript)(
        params as Parameters<typeof actual.appendInjectedAssistantMessageToTranscript>[0],
      ),
  };
});

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  transcriptAppendOverride.current = null;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-restart-recovery-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeSessionsDir(agentId = "main"): Promise<string> {
  const sessionsDir = path.join(tmpDir, "agents", agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

async function writeStore(sessionsDir: string, store: Record<string, SessionEntry>): Promise<void> {
  await fs.writeFile(path.join(sessionsDir, "sessions.json"), JSON.stringify(store, null, 2));
}

async function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  messages: unknown[],
): Promise<void> {
  const lines = messages.map((message) => JSON.stringify({ message })).join("\n");
  await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), `${lines}\n`);
}

function cleanedLockForPath(lockPath: string): SessionLockInspection {
  return {
    lockPath,
    pid: 999_999,
    pidAlive: false,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    ageMs: 1_000,
    stale: true,
    staleReasons: ["dead-pid"],
    removed: true,
  };
}

function cleanedLock(sessionsDir: string, sessionId: string): SessionLockInspection {
  return cleanedLockForPath(path.join(sessionsDir, `${sessionId}.jsonl.lock`));
}

function firstGatewayParams(): Record<string, unknown> {
  const call = vi.mocked(callGateway).mock.calls[0];
  if (!call) {
    throw new Error("expected gateway call");
  }
  const params = call[0].params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("expected gateway params");
  }
  return params as Record<string, unknown>;
}

describe("main-session-restart-recovery", () => {
  it("marks only matching running main sessions by active session key", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
      "agent:main:completed": {
        sessionId: "completed-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
      },
      "agent:main:subagent:child": {
        sessionId: "child-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        spawnDepth: 1,
      },
      "cron:nightly": {
        sessionId: "cron-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
      "agent:main:other": {
        sessionId: "other-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main", "agent:main:completed", "agent:main:subagent:child"],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 1 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:completed"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["cron:nightly"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:other"]?.abortedLastRun).toBeUndefined();
  });

  it("marks active sessions in a configured custom session store", async () => {
    const storePath = path.join(tmpDir, "custom", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:issue-82433": {
            sessionId: "custom-session",
            updatedAt: Date.now() - 10_000,
            status: "running",
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
    );
    await writeTranscript(path.dirname(storePath), "custom-session", [
      { role: "user", content: "continue this custom-store turn" },
      { role: "toolResult", content: "custom result" },
    ]);

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      sessionKeys: ["agent:main:issue-82433"],
    });

    const store = loadSessionStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:issue-82433"]?.abortedLastRun).toBe(true);

    const recovery = await recoverRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
    });

    expect(recovery).toEqual({ recovered: 1, failed: 0, skipped: 0 });
  });

  it("uses active session ids to avoid marking stale duplicate keys in another store", async () => {
    const defaultSessionsDir = await makeSessionsDir();
    await writeStore(defaultSessionsDir, {
      "agent:main:issue-82433": {
        sessionId: "stale-default-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const storePath = path.join(tmpDir, "custom-duplicate-key", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:issue-82433": {
            sessionId: "active-custom-session",
            updatedAt: Date.now() - 10_000,
            status: "running",
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
    );

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      sessionIds: ["active-custom-session"],
      sessionKeys: ["agent:main:issue-82433"],
    });

    const defaultStore = loadSessionStore(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = loadSessionStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(defaultStore["agent:main:issue-82433"]?.abortedLastRun).toBeUndefined();
    expect(customStore["agent:main:issue-82433"]?.abortedLastRun).toBe(true);
  });

  it("marks custom-store sessions by session id when no session key is available", async () => {
    const storePath = path.join(tmpDir, "custom-by-id", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:custom-by-id": {
            sessionId: "custom-session-id-only",
            updatedAt: Date.now() - 10_000,
            status: "running",
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
    );

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      sessionIds: ["custom-session-id-only"],
    });

    const store = loadSessionStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:custom-by-id"]?.abortedLastRun).toBe(true);
  });

  it("marks only main running sessions whose transcript lock was cleaned", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
      "agent:main:subagent:child": {
        sessionId: "child-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        spawnDepth: 1,
      },
      "agent:main:other": {
        sessionId: "other-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [
        cleanedLock(sessionsDir, "main-session"),
        cleanedLock(sessionsDir, "child-session"),
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 1 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:other"]?.abortedLastRun).toBeUndefined();
  });

  it("marks a running main session whose cleaned transcript lock is topic-suffixed", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionId = "main-session";
    const sessionFile = `${sessionId}-topic-1234567890.jsonl`;
    await writeStore(sessionsDir, {
      "agent:main:discord:channel:123:thread:1234567890": {
        sessionId,
        sessionFile,
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [cleanedLockForPath(path.join(sessionsDir, `${sessionFile}.lock`))],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:discord:channel:123:thread:1234567890"]?.abortedLastRun).toBe(true);
  });

  it("does not mark a session for an unrelated topic lock that only shares its id prefix", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        sessionFile: "main-session.jsonl",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [
        cleanedLockForPath(path.join(sessionsDir, "main-session-topic-unrelated.jsonl.lock")),
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.abortedLastRun).toBeUndefined();
  });

  it("normalizes relative cleaned lock paths against the current working directory", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionId = "main-session";
    const sessionFile = `${sessionId}-topic-1234567890.jsonl`;
    await writeStore(sessionsDir, {
      "agent:main:discord:channel:123:thread:1234567890": {
        sessionId,
        sessionFile,
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [
        cleanedLockForPath(
          path.relative(process.cwd(), path.join(sessionsDir, `${sessionFile}.lock`)),
        ),
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:discord:channel:123:thread:1234567890"]?.abortedLastRun).toBe(true);
  });

  it("falls back to the session id transcript lock when persisted sessionFile is outside the sessions dir", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        sessionFile: "../stale/outside.jsonl",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [cleanedLock(sessionsDir, "main-session")],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("falls back to the session id transcript lock when persisted sessionFile belongs to another generated session", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const otherSessionId = "22222222-2222-4222-8222-222222222222";
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId,
        sessionFile: `${otherSessionId}.jsonl`,
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [cleanedLock(sessionsDir, sessionId)],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("resumes marked sessions with a tool-result transcript tail", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const resumeParams = firstGatewayParams();
    expect(resumeParams.sessionKey).toBe("agent:main:main");
    expect(resumeParams.deliver).toBe(false);
    expect(resumeParams.lane).toBe("main");
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("delivers resumed marked sessions through the current run recovery context", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        deliveryContext: {
          channel: "discord",
          to: "discord:dm:stale",
          accountId: "old",
        },
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
          threadId: 123,
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    const resumeParams = firstGatewayParams();
    expect(resumeParams).toMatchObject({
      sessionKey: "agent:main:discord:direct:123",
      deliver: true,
      bestEffortDeliver: true,
      lane: "main",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      threadId: "123",
    });
  });

  it("does not infer restart delivery from historical session routes", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        deliveryContext: {
          channel: "discord",
          to: "discord:dm:stale",
          accountId: "old",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams().deliver).toBe(false);
  });

  it("does not deliver restart recovery when session send policy denies sends", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      cfg: { session: { sendPolicy: { default: "deny" } } },
      stateDir: tmpDir,
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams().deliver).toBe(false);
  });

  it("fails marked sessions with stale approval-pending exec tool results", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run a command that needs approval" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      {
        role: "toolResult",
        content: "Approval required (id stale, full stale-approval-id).",
        details: {
          status: "approval-pending",
          approvalId: "stale-approval-id",
          host: "gateway",
          command: "echo stale",
        },
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("resumes marked sessions with a durable pending final delivery payload (Phase 2)", async () => {
    const sessionsDir = await makeSessionsDir();
    const pendingPayload = "The final answer is 42.";
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: pendingPayload,
        pendingFinalDeliveryContext: {
          channel: "discord",
          to: "discord:dm:final",
          accountId: "main",
        },
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:stale",
          accountId: "old",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "calculate the answer" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
      { role: "toolResult", content: "42" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(firstGatewayParams()).toMatchObject({
      deliver: true,
      bestEffortDeliver: true,
      channel: "discord",
      to: "discord:dm:final",
      accountId: "main",
    });
    expect(firstGatewayParams().message).toContain(pendingPayload);

    const beforeStoreRead = Date.now();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    const entry = store["agent:main:main"];
    expect(entry?.abortedLastRun).toBe(false);
    expect(entry?.pendingFinalDelivery).toBe(true);
    expect(entry?.pendingFinalDeliveryText).toBe(pendingPayload);
    expect(entry?.pendingFinalDeliveryAttemptCount).toBe(1);
    expect(entry?.pendingFinalDeliveryLastError).toBeNull();
    expect(entry?.pendingFinalDeliveryCreatedAt).toBeLessThanOrEqual(beforeStoreRead);
    expect(entry?.pendingFinalDeliveryLastAttemptAt).toBeLessThanOrEqual(beforeStoreRead);
    expect(entry?.pendingFinalDeliveryLastAttemptAt ?? 0).toBeGreaterThanOrEqual(
      entry?.pendingFinalDeliveryCreatedAt ?? Number.POSITIVE_INFINITY,
    );
  });

  it("sanitizes durable pending final delivery payloads before resume prompts", async () => {
    const sessionsDir = await makeSessionsDir();
    const pendingPayload = [
      "The final answer is 42.",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "internal recovery detail",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"msg-1"}',
      "```",
    ].join("\n");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: pendingPayload,
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "calculate the answer" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
      { role: "toolResult", content: "42" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams().message).toContain("The final answer is 42.");
    expect(firstGatewayParams().message).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(firstGatewayParams().message).not.toContain("Conversation info");

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.pendingFinalDeliveryText).toBe("The final answer is 42.");
  });

  it("does not scan ordinary running sessions without the restart-aborted marker", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "current process owns this" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails marked sessions whose transcript tail cannot be resumed", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("sends a visible notice through legacy session route before failing an unresumable main session", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:demo-channel:room-1": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        lastChannel: "discord",
        lastTo: "discord:channel:room-1",
        lastAccountId: "default",
        lastThreadId: "thread-1",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const gatewayCall = vi.mocked(callGateway).mock.calls[0]?.[0] as
      | { method?: string; params?: Record<string, unknown> }
      | undefined;
    expect(gatewayCall?.method).toBe("message.action");
    expect(gatewayCall?.params).toMatchObject({
      channel: "discord",
      action: "send",
      accountId: "default",
      sessionKey: "agent:main:demo-channel:room-1",
      sessionId: "main-session",
    });
    expect(gatewayCall?.params?.params).toMatchObject({
      to: "discord:channel:room-1",
      threadId: "thread-1",
      bestEffort: true,
    });
    expect(String((gatewayCall?.params?.params as Record<string, unknown>)?.message)).toContain(
      "couldn't safely resume",
    );

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:demo-channel:room-1"]?.status).toBe("failed");
    expect(store["agent:main:demo-channel:room-1"]?.abortedLastRun).toBe(true);
  });

  it("persists the recovery notice to the WebChat transcript instead of an outbound action (#87808)", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:webchat:room-1": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        sessionFile: "main-session.jsonl",
        lastChannel: "webchat",
        lastTo: "webchat:room-1",
        lastAccountId: "default",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    // WebChat is an internal-only channel that rejects outbound message.action,
    // so no gateway send is issued for the recovery notice.
    const issuedMessageAction = vi
      .mocked(callGateway)
      .mock.calls.some((c) => (c[0] as { method?: string })?.method === "message.action");
    expect(issuedMessageAction).toBe(false);
    // The notice is persisted to the session transcript (disk), so a reconnecting
    // WebChat client renders the terminal notice instead of a silently vanished turn.
    // The notice is appended to the transcript the WebChat read path resolves
    // (<sessionsDir>/<sessionFile>), not a raw/out-of-dir persisted path.
    const transcript = await fs.readFile(path.join(sessionsDir, "main-session.jsonl"), "utf8");
    expect(transcript).toContain("couldn't safely resume");
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:webchat:room-1"]?.status).toBe("failed");
  });

  it("persists the WebChat recovery notice to the session-id transcript when sessionFile is missing (#87808)", async () => {
    const sessionsDir = await makeSessionsDir();
    // No persisted sessionFile: the recovery notice must still land on the
    // transcript the WebChat read path resolves (<sessionId>.jsonl in the
    // sessions dir), not be dropped for lack of an explicit sessionFile.
    await writeStore(sessionsDir, {
      "agent:main:webchat:room-1": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        lastChannel: "webchat",
        lastTo: "webchat:room-1",
        lastAccountId: "default",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    const issuedMessageAction = vi
      .mocked(callGateway)
      .mock.calls.some((c) => (c[0] as { method?: string })?.method === "message.action");
    expect(issuedMessageAction).toBe(false);
    const transcript = await fs.readFile(path.join(sessionsDir, "main-session.jsonl"), "utf8");
    expect(transcript).toContain("couldn't safely resume");
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:webchat:room-1"]?.status).toBe("failed");
  });

  it("persists the WebChat recovery notice to the session-id transcript when sessionFile points outside the sessions dir (#87808)", async () => {
    const sessionsDir = await makeSessionsDir();
    // A stale/out-of-dir sessionFile must not be appended to verbatim; the
    // resolver clamps the notice back to <sessionId>.jsonl inside the sessions dir.
    await writeStore(sessionsDir, {
      "agent:main:webchat:room-1": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        sessionFile: "../escape/outside.jsonl",
        lastChannel: "webchat",
        lastTo: "webchat:room-1",
        lastAccountId: "default",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    const transcript = await fs.readFile(path.join(sessionsDir, "main-session.jsonl"), "utf8");
    expect(transcript).toContain("couldn't safely resume");
    // The out-of-dir target must never be written.
    await expect(
      fs.access(path.join(tmpDir, "agents", "main", "escape", "outside.jsonl")),
    ).rejects.toThrow();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:webchat:room-1"]?.status).toBe("failed");
  });

  it("persists the WebChat recovery notice to <sessionId>.jsonl when sessionFile is a stale in-dir transcript the reconnect read path skips (#87808)", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const staleSessionFile = "22222222-2222-4222-8222-222222222222.jsonl";
    // sessionFile belongs to a *different* generated session id but still
    // resolves cleanly inside the sessions dir, so the old resolver would have
    // appended the notice to it. The reconnect read path
    // (resolveSessionTranscriptCandidates) classifies that as stale and reads
    // <sessionId>.jsonl first, so the write path must target <sessionId>.jsonl
    // too or the reconnecting WebChat client never sees the notice.
    await writeStore(sessionsDir, {
      "agent:main:webchat:room-1": {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        sessionFile: staleSessionFile,
        lastChannel: "webchat",
        lastTo: "webchat:room-1",
        lastAccountId: "default",
      },
    });
    await writeTranscript(sessionsDir, sessionId, [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    const issuedMessageAction = vi
      .mocked(callGateway)
      .mock.calls.some((c) => (c[0] as { method?: string })?.method === "message.action");
    expect(issuedMessageAction).toBe(false);
    // The notice lands on the read-path preferred candidate (<sessionId>.jsonl)...
    const transcript = await fs.readFile(path.join(sessionsDir, `${sessionId}.jsonl`), "utf8");
    expect(transcript).toContain("couldn't safely resume");
    // ...and never on the stale in-dir sessionFile the reconnect read path skips.
    await expect(fs.access(path.join(sessionsDir, staleSessionFile))).rejects.toThrow();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:webchat:room-1"]?.status).toBe("failed");
  });

  it("appends the WebChat recovery notice to the existing canonical <sessionId>.jsonl when a custom sessionFile is missing (#87808)", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionId = "main-session";
    // A custom/timestamped sessionFile that the resolver classifies as `custom`
    // (not stale): its `-topic-` prefix is not a generated session id, so it
    // resolves cleanly inside the sessions dir and would be the read path's
    // *preferred* (first) candidate. Crucially we never create it on disk, so
    // it is a missing preferred candidate while the canonical <sessionId>.jsonl
    // already holds the real (unresumable) history.
    const customSessionFile = "main-session-topic-9999.jsonl";
    await writeStore(sessionsDir, {
      "agent:main:webchat:room-1": {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        sessionFile: customSessionFile,
        lastChannel: "webchat",
        lastTo: "webchat:room-1",
        lastAccountId: "default",
      },
    });
    // The real session history lives in the existing canonical transcript.
    await writeTranscript(sessionsDir, sessionId, [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    const issuedMessageAction = vi
      .mocked(callGateway)
      .mock.calls.some((c) => (c[0] as { method?: string })?.method === "message.action");
    expect(issuedMessageAction).toBe(false);
    // (a) The notice is appended to the existing canonical <sessionId>.jsonl,
    // which is the first *existing* candidate the reconnect read path serves.
    const transcript = await fs.readFile(path.join(sessionsDir, `${sessionId}.jsonl`), "utf8");
    expect(transcript).toContain("couldn't safely resume");
    // (c) The original user/assistant history is preserved (the notice is
    // appended, not replaced by a notice-only transcript).
    expect(transcript).toContain("do the thing");
    expect(transcript).toContain("partial answer");
    // (b) The missing custom sessionFile must never be created: appending the
    // notice there would create a notice-only transcript that reconnect reads
    // first, hiding the real session history.
    await expect(fs.access(path.join(sessionsDir, customSessionFile))).rejects.toThrow();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:webchat:room-1"]?.status).toBe("failed");
  });

  it("reports a not-ok WebChat transcript append as a failed notice (#87808)", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:webchat:room-1": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        sessionFile: "main-session.jsonl",
        lastChannel: "webchat",
        lastTo: "webchat:room-1",
        lastAccountId: "default",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "partial answer" },
    ]);

    // appendInjectedAssistantMessageToTranscript swallows write errors and
    // returns { ok: false } rather than throwing. The recovery path must treat
    // that as a delivery failure instead of logging success.
    const appendSpy = vi.fn(async (params: { transcriptPath: string }) => {
      expect(params.transcriptPath).toBe(path.join(sessionsDir, "main-session.jsonl"));
      return { ok: false as const, error: "disk full" };
    });
    transcriptAppendOverride.current = appendSpy;

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(appendSpy).toHaveBeenCalledOnce();
    const issuedMessageAction = vi
      .mocked(callGateway)
      .mock.calls.some((c) => (c[0] as { method?: string })?.method === "message.action");
    expect(issuedMessageAction).toBe(false);
    // The session is still marked failed regardless of notice delivery outcome.
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:webchat:room-1"]?.status).toBe("failed");
  });
});
