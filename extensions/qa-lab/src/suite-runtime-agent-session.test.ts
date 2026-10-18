import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  loadTranscriptEventsSync,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { appendSqliteSessionTranscriptEventForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  readEffectiveTools,
  readRawQaSessionStore,
  readSessionTranscriptSummary,
  readSessionToolActivity,
  readSkillStatus,
  seedQaSessionEntries,
  seedQaSessionTranscript,
} from "./suite-runtime-agent-session.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";
import type { readQaNestedToolActivity } from "./tool-activity.js";

const execFileAsync = promisify(execFile);

const { cleanup, makeTempDir } = createTempDirHarness({
  beforeCleanup: closeQaRuntimeStores,
});

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests({ closeDatabase: false });
  clearRuntimeConfigSnapshot();
});

afterAll(cleanup);

describe("qa suite runtime agent session helpers", () => {
  let tempRoot: string;
  const gatewayCall = vi.fn();
  const env = {
    gateway: {
      call: gatewayCall,
      get tempRoot() {
        return tempRoot;
      },
    },
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-mini",
    providerMode: "mock-openai",
  } as never;

  beforeEach(async () => {
    tempRoot = await makeTempDir("qa-session-");
    setRuntimeConfigSnapshot({});
    gatewayCall.mockReset();
  });

  const qaPath = (...parts: string[]) => path.join(tempRoot, "state", "agents", "qa", ...parts);
  const identityFor = (sessionId: string, sessionKey: string) => ({
    agentId: "qa",
    env: { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "state") },
    sessionId,
    sessionKey,
  });

  async function createQaTranscript(sessionId = "session", sessionKey = "agent:qa:session") {
    const identity = identityFor(sessionId, sessionKey);
    await upsertSessionEntry({
      ...identity,
      entry: { sessionId, updatedAt: 10 },
    });
    return {
      sessionKey,
      append: (message: unknown) =>
        appendSessionTranscriptMessageByIdentity({ ...identity, message }),
      appendMany: async (messages: unknown[]) => {
        for (const message of messages) {
          await appendSessionTranscriptMessageByIdentity({ ...identity, message });
        }
      },
      read: (options?: Parameters<typeof readSessionTranscriptSummary>[2]) =>
        readSessionTranscriptSummary(env, sessionKey, options),
    };
  }

  function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
    return { type: "toolCall", id, name, arguments: args };
  }
  function assistantToolCall(id: string, name: string, args: Record<string, unknown> = {}) {
    return { role: "assistant", content: [toolCall(id, name, args)] };
  }

  function toolResult(
    toolCallId: string,
    toolName: string,
    details?: Record<string, unknown>,
    timestamp?: number,
  ) {
    return { role: "toolResult", toolCallId, toolName, details, isError: false, timestamp };
  }

  function textMessage(role: string, text: string, timestamp: number) {
    return { role, timestamp, content: [{ type: "text", text }] };
  }

  function seedEntries(
    agentId: string,
    entries: Record<string, Parameters<typeof seedQaSessionEntries>[1][number]["entry"]>,
  ) {
    return seedQaSessionEntries(
      env,
      Object.entries(entries).map(([sessionKey, entry]) => ({ agentId, sessionKey, entry })),
    );
  }

  function textResult(
    toolCallId: string,
    toolName: string,
    text: string,
    timestamp: number,
    isError = false,
  ) {
    return {
      ...toolResult(toolCallId, toolName),
      ...textMessage("toolResult", text, timestamp),
      isError,
    };
  }

  type NestedDetails = NonNullable<ReturnType<typeof readQaNestedToolActivity>>;
  function nestedTool(
    input: Pick<NestedDetails, "toolCallId" | "toolName" | "parentToolCallId" | "timestamp"> &
      Partial<NestedDetails>,
  ) {
    const details = {
      runId: "run-1",
      scopeId: "scope-1",
      afterEntryId: null,
      startOrder: 0,
      isError: false,
      startedAt: 100,
      input: {},
      result: { content: [] },
      ...input,
    };
    return {
      role: "custom",
      customType: "openclaw.nested-tool.v1",
      display: true,
      excludeFromContext: true,
      content: "",
      details,
      timestamp: details.timestamp,
    };
  }

  it.each(["sessions.create", "skills.status"] as const)(
    "reads %s with its default arguments and normalized result",
    async (method) => {
      const session = method === "sessions.create";
      gatewayCall.mockResolvedValueOnce(
        session ? { key: "  session-1  " } : { skills: [{ name: "alpha", eligible: true }] },
      );
      await expect(
        session ? createSession(env, "Test Session") : readSkillStatus(env),
      ).resolves.toEqual(session ? "session-1" : [{ name: "alpha", eligible: true }]);
      expect(gatewayCall).toHaveBeenNthCalledWith(
        1,
        method,
        session ? { label: "Test Session" } : { agentId: "qa" },
        expect.objectContaining({ timeoutMs: session ? 60_000 : 45_000 }),
      );
    },
  );

  it("reads effective tool ids once and drops blanks", async () => {
    gatewayCall.mockResolvedValueOnce({
      groups: [
        { tools: [{ id: "alpha" }, { id: " beta " }] },
        { tools: [{ id: "alpha" }, { id: "" }, {}] },
      ],
    });

    await expect(readEffectiveTools(env, "session-1")).resolves.toEqual(new Set(["alpha", "beta"]));
  });

  it("seeds QA session metadata and transcript messages in SQLite", async () => {
    const sessionId = "seeded-session";
    const sessionKey = "agent:qa:seeded-session";

    await seedQaSessionTranscript(env, {
      sessionId,
      sessionKey,
      updatedAt: 300,
      label: "Seeded QA transcript",
      messages: [
        { role: "user", text: "What is the codename?", timestamp: 100 },
        { role: "assistant", text: "The codename is ORBIT-10.", timestamp: 200 },
      ],
    });

    const sessionStore = await readRawQaSessionStore(env);
    expect(sessionStore).toMatchObject({
      [sessionKey]: {
        sessionId,
        updatedAt: 300,
        origin: { label: "Seeded QA transcript" },
      },
    });
    const transcriptEvents = loadTranscriptEventsSync(identityFor(sessionId, sessionKey));
    expect(
      transcriptEvents.flatMap((event) => {
        const message = (event as { message?: unknown }).message;
        return message ? [message] : [];
      }),
    ).toEqual([
      textMessage("user", "What is the codename?", 100),
      textMessage("assistant", "The codename is ORBIT-10.", 200),
    ]);

    await expect(fs.stat(qaPath("agent", "openclaw-agent.sqlite"))).resolves.toBeDefined();
    for (const file of ["sessions.json", `${sessionId}.jsonl`]) {
      await expect(fs.stat(qaPath("sessions", file))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("reads fresh session metadata after a separate process writes", async () => {
    const sessionKey = "agent:qa:external-write";
    await seedEntries("qa", {
      [sessionKey]: { sessionId: "external-write", updatedAt: 100, label: "before" },
    });
    // QA reads a Gateway-owned database without retaining an in-process writer.
    await closeQaRuntimeStores(tempRoot);
    await expect(readRawQaSessionStore(env)).resolves.toMatchObject({
      [sessionKey]: { label: "before" },
    });

    // Repeated external writes exercise readers that have already cached earlier metadata.
    for (const label of ["first", "second", "third", "fourth"]) {
      await execFileAsync(process.execPath, [
        "--input-type=module",
        "-e",
        `
          import { DatabaseSync } from "node:sqlite";
          const database = new DatabaseSync(process.argv[1]);
          try {
            const result = database.prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?"
            ).run(process.argv[3], process.argv[2]);
            if (result.changes !== 1) throw new Error("Expected one seeded session");
          } finally {
            database.close();
          }
        `,
        qaPath("agent", "openclaw-agent.sqlite"),
        sessionKey,
        label,
      ]);

      await expect(readRawQaSessionStore(env)).resolves.toMatchObject({
        [sessionKey]: { label },
      });
    }
  });

  it("seeds multi-agent session entries through the canonical accessor", async () => {
    const parentSessionKey = "agent:qa:main";
    const qaEntries = {
      [parentSessionKey]: { sessionId: "session-main", updatedAt: 300 },
      "agent:qa:subagent:child": {
        sessionId: "session-child",
        updatedAt: 200,
        spawnedBy: parentSessionKey,
        status: "done" as const,
        endedAt: 250,
      },
    };
    const claudeEntries = {
      "agent:claude:acp:child": {
        sessionId: "session-acp-child",
        updatedAt: 100,
        parentSessionKey,
      },
    };
    await seedEntries("qa", qaEntries);
    await seedEntries("claude", claudeEntries);
    for (const [agentId, entries] of [
      ["qa", qaEntries],
      ["claude", claudeEntries],
    ] as const) {
      await expect(readRawQaSessionStore(env, { agentId })).resolves.toMatchObject(entries);
    }
    const updated = {
      [parentSessionKey]: {
        sessionId: "session-main",
        updatedAt: 400,
        label: "Updated after the first read",
        compactionCount: 1,
      },
    };
    await seedEntries("qa", updated);
    const refreshed = await readRawQaSessionStore(env, { agentId: "qa" });
    expect(refreshed).toMatchObject({
      ...updated,
      "agent:qa:subagent:child": { sessionId: "session-child" },
    });
    expect(refreshed["agent:claude:acp:child"]).toBeUndefined();
  });

  it("reports bounded persisted compaction summaries", async () => {
    const sessionId = "compaction-summary";
    const sessionKey = "agent:qa:compaction-summary";
    const summaries = Array.from({ length: 18 }, (_, index) => `summary-${index}`);
    const transcript = await createQaTranscript(sessionId, sessionKey);

    let parentId: string | null = null;
    for (const [index, summary] of summaries.entries()) {
      const id = `compaction-${index}`;
      const event = {
        type: "compaction",
        id,
        parentId,
        timestamp: new Date(index).toISOString(),
        summary,
        firstKeptEntryId: id,
        tokensBefore: 100,
      };
      await appendSqliteSessionTranscriptEventForTest({
        ...identityFor(sessionId, sessionKey),
        event,
      });
      parentId = id;
    }
    await transcript.append({ role: "assistant", content: "done" });

    const result = await transcript.read();

    expect(result.compactionSummaries).toEqual(summaries.slice(-16));
    expect(result.finalText).toBe("done");
  });

  it("rejects an empty QA session transcript seed", async () => {
    await expect(
      seedQaSessionTranscript(env, {
        sessionId: "seeded-session",
        sessionKey: "agent:qa:seeded-session",
        updatedAt: 100,
        messages: [],
      }),
    ).rejects.toThrow("requires at least one message");
  });

  it("summarizes QA transcript events after non-assistant rows", async () => {
    const transcript = await createQaTranscript();
    const sendTool = { type: "tool_use", name: "message", input: { action: "send" } };
    await transcript.appendMany([
      { role: "user", content: "x".repeat(70 * 1024) },
      { role: "assistant", content: [sendTool] },
      {
        role: "assistant",
        content: "Sent.",
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      },
    ]);

    await expect(transcript.read()).resolves.toEqual({
      assistantToolCallCounts: { message: 1 },
      compactionSummaries: [],
      completedToolCallCounts: {},
      eventCursor: 4,
      userMessageCount: 1,
      successfulToolCallCounts: {},
      finalText: "Sent.",
      hasDirectReplySelfMessage: true,
      lastAssistantErrorMessage: "Request was aborted",
      lastAssistantStopReason: "aborted",
      lastMessageRole: "assistant",
    });
  });

  it("counts only correlated non-error tool results as successful", async () => {
    const transcript = await createQaTranscript();
    await transcript.append({
      role: "assistant",
      content: [
        toolCall("plan-ok", "progress_card"),
        toolCall("plan-error", "progress_card"),
        toolCall("write-mismatch", "write"),
      ],
    });
    await transcript.appendMany([
      textResult("plan-ok", "progress_card", "Progress card updated", 100),
      textResult("plan-ok", "progress_card", "duplicate", 200),
      textResult("plan-error", "progress_card", "failed", 300, true),
      textResult("write-mismatch", "exec", "wrong tool", 400),
    ]);

    await expect(transcript.read()).resolves.toMatchObject({
      assistantToolCallCounts: { progress_card: 2, write: 1 },
      completedToolCallCounts: { progress_card: 2 },
      successfulToolCallCounts: { progress_card: 1 },
      successfulToolCallEvents: [{ name: "progress_card", timestamp: 100, toolCallId: "plan-ok" }],
    });
  });

  it("counts Code Mode nested tool activity as the target tool's completed result", async () => {
    const transcript = await createQaTranscript();
    const { sessionKey } = transcript;
    const execCallId = "call_mock_exec_1|fc_mock_exec_1";
    const nestedActivity = (toolCallId: string, isError: boolean) =>
      nestedTool({
        startOrder: toolCallId === "nested-ok" ? 0 : 1,
        parentToolCallId: execCallId,
        toolCallId,
        toolName: "web_fetch",
        isError,
        timestamp: 150,
      });
    await transcript.appendMany([
      assistantToolCall(execCallId, "exec", { code: "" }),
      nestedActivity("nested-failed", true),
      nestedActivity("nested-ok", false),
      textResult(execCallId, "exec", '{"status":"completed"}', 200),
    ]);

    await expect(transcript.read()).resolves.toMatchObject({
      assistantToolCallCounts: { web_fetch: 2 },
      completedToolCallCounts: { web_fetch: 2 },
      successfulToolCallCounts: { web_fetch: 1 },
      successfulToolCallEvents: [{ name: "web_fetch", timestamp: 150, toolCallId: "nested-ok" }],
    });
    const activity = await readSessionToolActivity(env, sessionKey);
    expect(activity.filter((call) => call.kind === "tool").map((call) => call.toolCallId)).toEqual([
      "nested-ok",
      "nested-failed",
    ]);
    const wireSummary = await transcript.read({ includeCodeModeControl: true });
    expect(wireSummary.assistantToolCallCounts).toEqual({ exec: 1, web_fetch: 2 });
    expect(wireSummary.completedToolCallCounts).toEqual({ exec: 1, web_fetch: 2 });
    expect(wireSummary.successfulToolCallCounts).toEqual({ exec: 1, web_fetch: 1 });
  });

  it("counts physical shell results without Code Mode wrappers or failed exits", async () => {
    const transcript = await createQaTranscript();
    for (const [index, exitCode] of [1, 0, 0].entries()) {
      const wrapperId = `wrapper-${index}`;
      const nested = nestedTool({
        scopeId: `scope-${index}`,
        parentToolCallId: wrapperId,
        toolCallId: `shell-${index}`,
        toolName: "exec",
        input: { command: "proof" },
        result: { content: [], details: { status: "completed", exitCode } },
        startedAt: 100 + index * 10,
        timestamp: 105 + index * 10,
      });
      await transcript.appendMany([
        assistantToolCall(wrapperId, "exec", { code: "await exec({ command: 'proof' });" }),
        nested,
        nested,
        toolResult(wrapperId, "exec", { status: "completed" }, 109 + index * 10),
      ]);
    }
    await transcript.appendMany([
      assistantToolCall("direct-failed", "exec", { command: "proof" }),
      toolResult("direct-failed", "exec", { status: "completed", exitCode: 1 }, 200),
    ]);

    await expect(transcript.read()).resolves.toMatchObject({
      assistantToolCallCounts: { exec: 4 },
      completedToolCallCounts: { exec: 4 },
      successfulToolCallCounts: { exec: 2 },
      successfulToolCallEvents: [
        { name: "exec", timestamp: 115, toolCallId: "shell-1" },
        { name: "exec", timestamp: 125, toolCallId: "shell-2" },
      ],
    });
  });

  it("retains persisted append boundaries for tied serial and overlapping nested tools", async () => {
    const transcript = await createQaTranscript();
    const { sessionKey } = transcript;
    const wrapper = await transcript.append({
      ...assistantToolCall("wrapper", "exec", { code: "dispatch task tools" }),
      timestamp: 100,
    });
    assert(wrapper, "missing persisted wrapper");
    const appendNested = (toolCallId: string, startOrder: number, afterEntryId: string) =>
      transcript.append(
        nestedTool({
          afterEntryId,
          startOrder,
          parentToolCallId: "wrapper",
          toolCallId,
          toolName: "read",
          timestamp: 100,
        }),
      );
    await appendNested("first", 0, wrapper.messageId);
    const overlap = await appendNested("overlap", 1, wrapper.messageId);
    assert(overlap, "missing persisted overlapping result");
    await appendNested("serial", 2, overlap.messageId);

    const activity = await readSessionToolActivity(env, sessionKey);
    const [wrapperActivity, , overlapActivity] = activity;
    assert(wrapperActivity && overlapActivity, "missing projected causal tool activity");
    expect(activity).toMatchObject([
      { toolCallId: "wrapper", startAfterIndex: wrapperActivity.callIndex - 1 },
      { toolCallId: "first", startAfterIndex: wrapperActivity.callIndex },
      { toolCallId: "overlap", startAfterIndex: wrapperActivity.callIndex },
      { toolCallId: "serial", startAfterIndex: overlapActivity.resultIndex },
    ]);
  });

  it("matches pending Code Mode waits to the exec checkpoint that created their run", async () => {
    const transcript = await createQaTranscript();
    const readPending = (pendingCodeModeExecNeedle: string) =>
      transcript.read({ pendingCodeModeExecNeedle });

    await transcript.appendMany([
      assistantToolCall("checkpoint-1-exec", "exec", {
        code: "await qa_restart_wait(); return 'CHECKPOINT-1';",
      }),
      toolResult("checkpoint-1-exec", "exec", { status: "waiting", runId: "checkpoint-1-run" }),
      assistantToolCall("checkpoint-1-wait", "wait", { runId: "checkpoint-1-run" }),
      toolResult("checkpoint-1-wait", "wait", { status: "completed" }),
      assistantToolCall("audit-exec", "exec", {
        code: "return await catalog.search('qa_restart_unsafe_probe');",
      }),
      toolResult("audit-exec", "exec", { status: "waiting", runId: "audit-run" }),
      assistantToolCall("audit-wait", "wait", { runId: "audit-run" }),
    ]);

    await expect(readPending("CHECKPOINT-1")).resolves.toMatchObject({
      hasPendingCodeModeWait: false,
    });

    await transcript.appendMany([
      assistantToolCall("checkpoint-2-exec", "exec", {
        code: "await qa_restart_wait(); return 'CHECKPOINT-2';",
      }),
      toolResult("checkpoint-2-exec", "exec", { status: "waiting", runId: "checkpoint-2-run" }),
      assistantToolCall("checkpoint-2-wait", "wait", { runId: "checkpoint-2-run" }),
    ]);

    await expect(readPending("CHECKPOINT-2")).resolves.toMatchObject({
      hasPendingCodeModeWait: true,
    });
  });

  it("separates native-blocks cell controls from unmatched waits and physical exec", async () => {
    const transcript = await createQaTranscript();
    const { sessionKey } = transcript;
    const waitInput = (id: string) => ({ arguments: JSON.stringify({ cell_id: id }) });
    const header = "Script running with cell ID cell-owned\nWall time 0.1 seconds\nOutput:\n";
    const wrapperText = JSON.stringify([{ type: "input_text", text: header }]);
    await transcript.appendMany([
      assistantToolCall("wrapper", "exec", { input: "await work();" }),
      assistantToolCall("early-wait", "wait", waitInput("cell-owned")),
      toolResult("early-wait", "wait", {}),
      {
        ...toolResult("wrapper", "exec", {}),
        content: [{ type: "text", text: wrapperText }],
      },
      assistantToolCall("matched-wait", "wait", waitInput("cell-owned")),
      toolResult("matched-wait", "wait", {}),
      assistantToolCall("shell", "exec", { command: "printf proof" }),
      {
        ...toolResult("shell", "exec", { status: "completed", exitCode: 0 }),
        content: [{ type: "text", text: header.replace("cell-owned", "cell-unmatched") }],
      },
      assistantToolCall("unmatched-wait", "wait", waitInput("cell-unmatched")),
      toolResult("unmatched-wait", "wait", {}),
    ]);
    const summary = await transcript.read();
    expect(summary.assistantToolCallCounts).toEqual({ exec: 1, wait: 2 });
    expect(summary.successfulToolCallCounts).toEqual({ exec: 1, wait: 2 });
    const activity = await readSessionToolActivity(env, sessionKey);
    expect(
      activity.filter((call) => call.kind === "code-mode-control").map((call) => call.toolCallId),
    ).toEqual(["wrapper", "matched-wait"]);
    const wireSummary = await transcript.read({ includeCodeModeControl: true });
    expect(wireSummary.assistantToolCallCounts).toEqual({ exec: 2, wait: 3 });
  });

  it("rejects ambiguous receipts and unfinished shell polls while preserving domain statuses", async () => {
    const transcript = await createQaTranscript();
    const command = { command: "proof" };
    for (const [id, name, input, details] of [
      ["running", "process", { action: "poll" }, { status: "running" }],
      ["failed", "process", { action: "poll" }, { status: "completed", exitCode: 1 }],
      ["ok", "process", { action: "poll" }, { status: "completed", exitCode: 0 }],
      ["write", "process", { action: "write" }, { status: "running" }],
      ["domain", "progress_card", {}, { status: "running" }],
      ["unavailable", "exec", command, { status: "unavailable" }],
      ["gateway-failed", "gateway_exec", command, { status: "completed", exitCode: 1 }],
      ["gateway-poll", "gateway_process", { action: "poll" }, { status: "running" }],
      ["conflict", "exec", command, { status: "completed", exitCode: 0 }],
    ] as const) {
      await transcript.append(assistantToolCall(id, name, input));
      await transcript.append(toolResult(id, name, details, 100));
    }
    await transcript.append(
      toolResult("conflict", "exec", { status: "completed", exitCode: 1 }, 101),
    );
    const summary = await transcript.read();
    expect(summary).toMatchObject({
      assistantToolCallCounts: {
        process: 4,
        progress_card: 1,
        exec: 2,
        gateway_exec: 1,
        gateway_process: 1,
      },
      completedToolCallCounts: { process: 3, progress_card: 1, exec: 1, gateway_exec: 1 },
    });
    expect(summary.successfulToolCallCounts).toEqual({ process: 2, progress_card: 1 });
  });

  it("bounds authenticated successful tool results to the latest 64 events", async () => {
    const transcript = await createQaTranscript();
    await transcript.append({
      role: "assistant",
      content: Array.from({ length: 65 }, (_, index) => toolCall(`call-${index}`, "exec")),
    });

    for (let index = 0; index < 65; index += 1) {
      await transcript.append(toolResult(`call-${index}`, "exec", undefined, index));
    }

    const summary = await transcript.read();

    expect(summary.successfulToolCallCounts).toEqual({ exec: 65 });
    expect(summary.successfulToolCallEvents).toHaveLength(64);
    const events = summary.successfulToolCallEvents;
    expect([events?.[0], events?.at(-1)]).toEqual([
      { name: "exec", timestamp: 1, toolCallId: "call-1" },
      { name: "exec", timestamp: 64, toolCallId: "call-64" },
    ]);
  });

  it("reports current-source delivery facts from runtime-only tool result details", async () => {
    const transcript = await createQaTranscript();
    const details = { sourceReplyRoute: "current-source", receipt: { threadId: "thread-1" } };
    await transcript.append(toolResult("message-1", "message", details, 100));

    await expect(transcript.read()).resolves.toMatchObject({
      currentSourceToolDeliveries: [{ toolName: "message", threadId: "thread-1" }],
    });
  });

  it("scopes transcript evidence after an event cursor", async () => {
    const transcript = await createQaTranscript();
    const mirror = (identity: string) => ({
      role: "assistant",
      content: "same visible reply",
      __openclaw: { mirrorIdentity: identity },
    });
    await transcript.appendMany([
      assistantToolCall("old-plan", "progress_card", {}),
      textResult("old-plan", "progress_card", "Progress card updated", 100),
      mirror("old-turn:assistant"),
    ]);
    const checkpoint = await transcript.read();
    expect(checkpoint.successfulToolCallEvents).toEqual([
      { name: "progress_card", timestamp: 100, toolCallId: "old-plan" },
    ]);
    await transcript.append(mirror("current-turn:assistant"));

    const summary = await transcript.read({ afterEventCursor: checkpoint.eventCursor });

    expect(summary).toMatchObject({
      assistantMirrors: [{ identity: "current-turn:assistant", text: "same visible reply" }],
      assistantToolCallCounts: {},
      eventCursor: 5,
      successfulToolCallCounts: {},
    });
    expect(summary.successfulToolCallEvents).toBeUndefined();
  });

  it("returns an empty checkpoint before the session exists", async () => {
    await expect(
      readSessionTranscriptSummary(env, "agent:qa:not-created-yet", {
        allowEmpty: true,
      }),
    ).resolves.toEqual({
      assistantToolCallCounts: {},
      compactionSummaries: [],
      completedToolCallCounts: {},
      eventCursor: 0,
      userMessageCount: 0,
      successfulToolCallCounts: {},
      finalText: "",
      hasDirectReplySelfMessage: false,
    });
  });

  it("fails closed when a requested QA session transcript is empty", async () => {
    const transcript = await createQaTranscript();

    await expect(transcript.read()).rejects.toThrow("session transcript is empty");
  });

  it("fails closed when a requested QA session transcript entry is missing", async () => {
    await expect(readSessionTranscriptSummary(env, "agent:qa:missing")).rejects.toThrow(
      "session transcript entry not found",
    );
  });
});
