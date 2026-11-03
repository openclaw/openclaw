import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeQaRuntimeStores, wrapPromptDataBlock } from "openclaw/plugin-sdk/qa-runtime";
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
import { nestedToolActivityFixture } from "../test/nested-tool-activity-fixture.js";
import {
  createSession,
  readEffectiveTools,
  readRawQaSessionStore as readStore,
  readSubagentHandoffReply,
  readSessionTranscriptSummary as readSummary,
  readSessionToolActivity as readActivity,
  readSkillStatus,
  seedQaSessionEntries,
  seedQaSessionTranscript as seedTranscript,
} from "./suite-runtime-agent-session.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";
import type { readQaNestedToolActivity } from "./tool-activity.js";

const execFileAsync = promisify(execFile);

const { cleanup, makeTempDir } = createTempDirHarness({ beforeCleanup: closeQaRuntimeStores });

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

  async function makeTranscript(
    messages: unknown[] = [],
    sessionId = "session",
    sessionKey = "agent:qa:session",
  ) {
    const identity = identityFor(sessionId, sessionKey);
    await upsertSessionEntry({ ...identity, entry: { sessionId, updatedAt: 10 } });
    const append = (message: unknown) =>
      appendSessionTranscriptMessageByIdentity({ ...identity, message });
    const appendMany = async (batch: unknown[]) => {
      for (const message of batch) {
        await append(message);
      }
    };
    await appendMany(messages);
    return {
      sessionKey,
      append,
      appendMany,
      read: (options?: Parameters<typeof readSummary>[2]) => readSummary(env, sessionKey, options),
    };
  }

  it("credits the active handoff turn across metadata, but not a side append", async () => {
    const { sessionKey, append } = await makeTranscript();
    const appendEvent = (event: Record<string, unknown>) =>
      appendSqliteSessionTranscriptEventForTest({ ...identityFor("session", sessionKey), event });
    const childKey = "agent:qa:subagent:child";
    const childReply = "Child complete.";
    const request = await append({ role: "user", content: "Delegate a task." });
    const settlement = await append({
      role: "user",
      content:
        "status: ok\n" +
        wrapPromptDataBlock({ label: "Child result", text: childReply, encoding: "verbatim" }),
      provenance: {
        kind: "inter_session",
        sourceChannel: "internal",
        sourceTool: "subagent_settle",
        sourceSessionKey: childKey,
      },
    });
    assert(request && settlement);
    await appendEvent({
      type: "custom_message",
      id: "context",
      parentId: settlement.messageId,
      customType: "openclaw.runtime-context",
      content: "Runtime context for the child.",
      display: false,
    });
    await appendEvent({ type: "custom", id: "prompt", parentId: "context", customType: "fixture" });
    const reply = {
      role: "assistant",
      content: `Delegated task:\nCheck fixture.\nResult:\n${childReply}\nEvidence:\nDone.`,
    };
    const readReply = (id: string) =>
      readSubagentHandoffReply(env, sessionKey, childKey, childReply, [
        { ...reply, __openclaw: { id } },
      ]);
    const report = await append(reply);
    assert(report);
    await expect(readReply(report.messageId)).resolves.toBe(reply.content);

    await appendEvent({
      type: "leaf",
      id: "navigate",
      parentId: report.messageId,
      targetId: request.messageId,
    });
    await append({ role: "user", content: "Start another task." });
    await appendEvent({
      type: "custom",
      id: "side-note",
      parentId: settlement.messageId,
      appendMode: "side",
      customType: "fixture",
    });
    const otherReport = await append(reply);
    assert(otherReport);
    await expect(readReply(otherReport.messageId)).resolves.toBeUndefined();
  });

  function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
    return { type: "toolCall", id, name, arguments: args };
  }
  function call(id: string, name: string, args: Record<string, unknown> = {}) {
    return { role: "assistant", content: [toolCall(id, name, args)] };
  }

  type Details = Record<string, unknown>;
  function toolResult(toolCallId: string, toolName: string, details?: Details, timestamp?: number) {
    return { role: "toolResult", toolCallId, toolName, details, isError: false, timestamp };
  }

  function textMessage(role: string, text: string, timestamp: number) {
    return { role, timestamp, content: [{ type: "text", text }] };
  }

  function counts(summary: Awaited<ReturnType<typeof readSummary>>) {
    return [
      summary.assistantToolCallCounts,
      summary.completedToolCallCounts,
      summary.successfulToolCallCounts,
    ];
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
    toolCallId: string,
    toolName: string,
    parentToolCallId: string,
    timestamp: number,
    overrides: Partial<NestedDetails> = {},
  ) {
    const fixture = nestedToolActivityFixture({ toolCallId, toolName, input: {}, text: "" });
    return {
      ...fixture,
      details: {
        ...fixture.details,
        afterEntryId: null,
        result: { content: [] },
        parentToolCallId,
        timestamp,
        ...overrides,
      },
      timestamp,
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

    await seedTranscript(env, {
      sessionId,
      sessionKey,
      updatedAt: 300,
      label: "Seeded QA transcript",
      messages: [
        { role: "user", text: "What is the codename?", timestamp: 100 },
        { role: "assistant", text: "The codename is ORBIT-10.", timestamp: 200 },
      ],
    });

    const sessionStore = await readStore(env);
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
    await expect(readStore(env)).resolves.toMatchObject({
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

      await expect(readStore(env)).resolves.toMatchObject({ [sessionKey]: { label } });
    }
  });

  it("seeds multi-agent session entries through the canonical accessor", async () => {
    const parentSessionKey = "agent:qa:main";
    const entry = (sessionId: string, updatedAt: number) => ({ sessionId, updatedAt });
    const qaEntries = {
      [parentSessionKey]: entry("session-main", 300),
      "agent:qa:subagent:child": {
        ...entry("session-child", 200),
        spawnedBy: parentSessionKey,
        status: "done" as const,
        endedAt: 250,
      },
    };
    const claudeEntries = {
      "agent:claude:acp:child": { ...entry("session-acp-child", 100), parentSessionKey },
    };
    await seedEntries("qa", qaEntries);
    await seedEntries("claude", claudeEntries);
    for (const [agentId, entries] of [
      ["qa", qaEntries],
      ["claude", claudeEntries],
    ] as const) {
      await expect(readStore(env, { agentId })).resolves.toMatchObject(entries);
    }
    const updated = {
      [parentSessionKey]: {
        ...entry("session-main", 400),
        label: "Updated after the first read",
        compactionCount: 1,
      },
    };
    await seedEntries("qa", updated);
    const refreshed = await readStore(env, { agentId: "qa" });
    expect(refreshed).toMatchObject({
      ...updated,
      "agent:qa:subagent:child": { sessionId: "session-child" },
    });
    expect(refreshed["agent:claude:acp:child"]).toBeUndefined();
  });

  it("reports bounded persisted compaction summaries", async () => {
    const sessionId = "compaction-summary",
      sessionKey = "agent:qa:compaction-summary";
    const summaries = Array.from({ length: 18 }, (_, index) => `summary-${index}`);
    const transcript = await makeTranscript([], sessionId, sessionKey);

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
      seedTranscript(env, {
        sessionId: "seeded-session",
        sessionKey: "agent:qa:seeded-session",
        updatedAt: 100,
        messages: [],
      }),
    ).rejects.toThrow("requires at least one message");
  });

  it("summarizes QA transcript events after non-assistant rows", async () => {
    const sendTool = { type: "tool_use", name: "message", input: { action: "send" } };
    const transcript = await makeTranscript([
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
    });
  });

  it("counts only correlated non-error results across direct and nested tool activity", async () => {
    const execCallId = "call_mock_exec_1|fc_mock_exec_1";
    const nestedActivity = (toolCallId: string, isError: boolean) =>
      nestedTool(toolCallId, "web_fetch", execCallId, 150, {
        startOrder: toolCallId === "nested-ok" ? 0 : 1,
        isError,
      });
    const transcript = await makeTranscript([
      {
        role: "assistant",
        content: [
          toolCall("plan-ok", "read"),
          toolCall("plan-error", "read"),
          toolCall("write-mismatch", "write"),
        ],
      },
      textResult("plan-ok", "read", "Progress card updated", 100),
      textResult("plan-ok", "read", "duplicate", 200),
      textResult("plan-error", "read", "failed", 300, true),
      textResult("write-mismatch", "exec", "wrong tool", 400),
      call(execCallId, "exec", { code: "" }),
      nestedActivity("nested-failed", true),
      nestedActivity("nested-ok", false),
      textResult(execCallId, "exec", '{"status":"completed"}', 200),
    ]);

    await expect(transcript.read()).resolves.toMatchObject({
      assistantToolCallCounts: { read: 2, write: 1, web_fetch: 2 },
      completedToolCallCounts: { read: 2, web_fetch: 2 },
      successfulToolCallCounts: { read: 1, web_fetch: 1 },
      successfulToolCallEvents: [
        { name: "read", timestamp: 100, toolCallId: "plan-ok" },
        { name: "web_fetch", timestamp: 150, toolCallId: "nested-ok" },
      ],
    });
    const activity = await readActivity(env, transcript.sessionKey);
    expect(
      activity
        .filter((operation) => operation.kind === "tool" && operation.toolName === "web_fetch")
        .map((operation) => operation.toolCallId),
    ).toEqual(["nested-ok", "nested-failed"]);
    const wireSummary = await transcript.read({ includeCodeModeControl: true });
    expect(counts(wireSummary)).toEqual([
      { read: 2, write: 1, exec: 1, web_fetch: 2 },
      { read: 2, exec: 1, web_fetch: 2 },
      { read: 1, exec: 1, web_fetch: 1 },
    ]);
  });

  it("counts physical shell results without Code Mode wrappers or failed exits", async () => {
    const transcript = await makeTranscript();
    for (const [index, exitCode] of [1, 0, 0].entries()) {
      const wrapperId = `wrapper-${index}`;
      const nested = nestedTool(`shell-${index}`, "exec", wrapperId, 105 + index * 10, {
        scopeId: `scope-${index}`,
        input: { command: "proof" },
        result: { content: [], details: { status: "completed", exitCode } },
        startedAt: 100 + index * 10,
      });
      await transcript.appendMany([
        call(wrapperId, "exec", { code: "await exec({ command: 'proof' });" }),
        nested,
        nested,
        toolResult(wrapperId, "exec", { status: "completed" }, 109 + index * 10),
      ]);
    }
    await transcript.appendMany([
      call("direct-failed", "exec", { command: "proof" }),
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
    const transcript = await makeTranscript();
    const { sessionKey } = transcript;
    const wrapper = await transcript.append({
      ...call("wrapper", "exec", { code: "dispatch task tools" }),
      timestamp: 100,
    });
    assert(wrapper, "missing persisted wrapper");
    const appendNested = (toolCallId: string, startOrder: number, afterEntryId: string) =>
      transcript.append(
        nestedTool(toolCallId, "read", "wrapper", 100, { afterEntryId, startOrder }),
      );
    await appendNested("first", 0, wrapper.messageId);
    const overlap = await appendNested("overlap", 1, wrapper.messageId);
    assert(overlap, "missing persisted overlapping result");
    await appendNested("serial", 2, overlap.messageId);

    const activity = await readActivity(env, sessionKey);
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
    const transcript = await makeTranscript();
    const readPending = (pendingCodeModeExecNeedle: string) =>
      transcript.read({ pendingCodeModeExecNeedle });
    const pending = (id: string, code: string) => [
      call(`${id}-exec`, "exec", { code }),
      toolResult(`${id}-exec`, "exec", { status: "waiting", runId: `${id}-run` }),
      call(`${id}-wait`, "wait", { runId: `${id}-run` }),
    ];
    await transcript.appendMany([
      ...pending("checkpoint-1", "await qa_restart_wait(); return 'CHECKPOINT-1';"),
      toolResult("checkpoint-1-wait", "wait", { status: "completed" }),
      ...pending("audit", "return await catalog.search('read');"),
    ]);

    await expect(readPending("CHECKPOINT-1")).resolves.toMatchObject({
      hasPendingCodeModeWait: false,
    });

    await transcript.appendMany(
      pending("checkpoint-2", "await qa_restart_wait(); return 'CHECKPOINT-2';"),
    );

    await expect(readPending("CHECKPOINT-2")).resolves.toMatchObject({
      hasPendingCodeModeWait: true,
    });
  });

  it("separates native-blocks cell controls from unmatched waits and physical exec", async () => {
    const waitInput = (id: string) => ({ arguments: JSON.stringify({ cell_id: id }) });
    const header = "Script running with cell ID cell-owned\nWall time 0.1 seconds\nOutput:\n";
    const wrapperText = JSON.stringify([{ type: "input_text", text: header }]);
    const transcript = await makeTranscript([
      call("wrapper", "exec", { input: "await work();" }),
      call("early-wait", "wait", waitInput("cell-owned")),
      toolResult("early-wait", "wait", {}),
      {
        ...toolResult("wrapper", "exec", {}),
        content: [{ type: "text", text: wrapperText }],
      },
      call("matched-wait", "wait", waitInput("cell-owned")),
      toolResult("matched-wait", "wait", {}),
      call("shell", "exec", { command: "printf proof" }),
      {
        ...toolResult("shell", "exec", { status: "completed", exitCode: 0 }),
        content: [{ type: "text", text: header.replace("cell-owned", "cell-unmatched") }],
      },
      call("unmatched-wait", "wait", waitInput("cell-unmatched")),
      toolResult("unmatched-wait", "wait", {}),
    ]);
    const summary = await transcript.read();
    expect(summary.assistantToolCallCounts).toEqual({ exec: 1, wait: 2 });
    expect(summary.successfulToolCallCounts).toEqual({ exec: 1, wait: 2 });
    const activity = await readActivity(env, transcript.sessionKey);
    expect(
      activity
        .filter((operation) => operation.kind === "code-mode-control")
        .map((operation) => operation.toolCallId),
    ).toEqual(["wrapper", "matched-wait"]);
    const wireSummary = await transcript.read({ includeCodeModeControl: true });
    expect(wireSummary.assistantToolCallCounts).toEqual({ exec: 2, wait: 3 });
  });

  it("rejects ambiguous receipts and unfinished shell polls while preserving domain statuses", async () => {
    const transcript = await makeTranscript();
    const command = { command: "proof" };
    for (const [id, name, input, details] of [
      ["running", "process", { action: "poll" }, { status: "running" }],
      ["failed", "process", { action: "poll" }, { status: "completed", exitCode: 1 }],
      ["ok", "process", { action: "poll" }, { status: "completed", exitCode: 0 }],
      ["write", "process", { action: "write" }, { status: "running" }],
      ["domain", "read", {}, { status: "running" }],
      ["unavailable", "exec", command, { status: "unavailable" }],
      ["gateway-failed", "gateway_exec", command, { status: "completed", exitCode: 1 }],
      ["gateway-poll", "gateway_process", { action: "poll" }, { status: "running" }],
      ["conflict", "exec", command, { status: "completed", exitCode: 0 }],
    ] as const) {
      await transcript.append(call(id, name, input));
      await transcript.append(toolResult(id, name, details, 100));
    }
    await transcript.append(
      toolResult("conflict", "exec", { status: "completed", exitCode: 1 }, 101),
    );
    expect(counts(await transcript.read())).toEqual([
      { process: 4, read: 1, exec: 2, gateway_exec: 1, gateway_process: 1 },
      { process: 3, read: 1, exec: 1, gateway_exec: 1 },
      { process: 2, read: 1 },
    ]);
  });

  it("bounds authenticated successful tool results to the latest 64 events", async () => {
    const transcript = await makeTranscript([
      {
        role: "assistant",
        content: Array.from({ length: 65 }, (_, index) => toolCall(`call-${index}`, "exec")),
      },
    ]);

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
    const details = { sourceReplyRoute: "current-source", receipt: { threadId: "thread-1" } };
    const transcript = await makeTranscript([toolResult("message-1", "message", details, 100)]);

    await expect(transcript.read()).resolves.toMatchObject({
      currentSourceToolDeliveries: [{ toolName: "message", threadId: "thread-1" }],
    });
  });

  it("scopes transcript evidence after an event cursor", async () => {
    const mirror = (identity: string) => ({
      role: "assistant",
      content: "same visible reply",
      __openclaw: { mirrorIdentity: identity },
    });
    const transcript = await makeTranscript([
      call("old-plan", "read", {}),
      textResult("old-plan", "read", "Progress card updated", 100),
      mirror("old-turn:assistant"),
    ]);
    const checkpoint = await transcript.read();
    expect(checkpoint.successfulToolCallEvents).toEqual([
      { name: "read", timestamp: 100, toolCallId: "old-plan" },
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
      readSummary(env, "agent:qa:not-created-yet", {
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
    const transcript = await makeTranscript();

    await expect(transcript.read()).rejects.toThrow("session transcript is empty");
  });

  it("fails closed when a requested QA session transcript entry is missing", async () => {
    await expect(readSummary(env, "agent:qa:missing")).rejects.toThrow(
      "session transcript entry not found",
    );
  });
});
