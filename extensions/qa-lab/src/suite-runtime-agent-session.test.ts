// Qa Lab tests cover suite runtime agent session plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  loadTranscriptEventsSync,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  appendSqliteSessionTranscriptEventForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  readEffectiveTools,
  readRawQaSessionStore,
  readSessionTranscriptSummary,
  readSkillStatus,
  seedQaSessionEntries,
  seedQaSessionTranscript,
} from "./suite-runtime-agent-session.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();

afterEach(async () => {
  vi.useRealTimers();
  // Fixtures point a state dir at these temp workspaces, so the shared and per-agent
  // SQLite handles stay cached and Windows fails the removal with EBUSY. The agent close
  // releases its leases through shared state and reopens it, so the store is released second.
  // Native worker close (and its shared-state lease release) is asynchronous, so it must be
  // awaited before the temp root is removed below -- otherwise the deferred release can stat
  // a path that cleanup() already deleted.
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  await cleanup();
});

describe("qa suite runtime agent session helpers", () => {
  const gatewayCall = vi.fn();
  const env = {
    gateway: { call: gatewayCall },
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-mini",
    providerMode: "mock-openai",
  } as never;

  beforeEach(() => {
    gatewayCall.mockReset();
  });

  function qaSessionEnv(tempRoot: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
    };
  }

  async function createQaTranscript(params: {
    sessionId: string;
    sessionKey: string;
    tempRoot: string;
  }) {
    const identity = {
      agentId: "qa",
      env: qaSessionEnv(params.tempRoot),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    };
    await upsertSessionEntry({
      ...identity,
      entry: { sessionId: params.sessionId, updatedAt: 10 },
    });
    return {
      append: (message: unknown) =>
        appendSessionTranscriptMessageByIdentity({ ...identity, message }),
      read: (options?: Parameters<typeof readSessionTranscriptSummary>[2]) =>
        readSessionTranscriptSummary(
          { gateway: { tempRoot: params.tempRoot } } as never,
          params.sessionKey,
          options,
        ),
    };
  }

  function assistantToolCall(id: string, name: string, args: Record<string, unknown>) {
    return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
  }

  function toolResult(toolCallId: string, toolName: string, details: Record<string, unknown>) {
    return { role: "toolResult", toolCallId, toolName, details, isError: false };
  }

  function requireGatewayCall() {
    const [call] = gatewayCall.mock.calls;
    if (!call) {
      throw new Error("expected gateway call");
    }
    return call;
  }

  it("creates sessions and trims the returned key", async () => {
    gatewayCall.mockResolvedValueOnce({ key: "  session-1  " });

    await expect(createSession(env, "Test Session")).resolves.toBe("session-1");
    const [method, params, options] = requireGatewayCall();
    expect(method).toBe("sessions.create");
    expect(params).toEqual({ label: "Test Session" });
    expect(options?.timeoutMs).toBe(60_000);
  });

  it("reads effective tool ids once and drops blanks", async () => {
    gatewayCall.mockResolvedValueOnce({
      groups: [
        { tools: [{ id: "alpha" }, { id: " beta " }] },
        { tools: [{ id: "alpha" }, { id: "" }, {}] },
      ],
    });

    await expect(readEffectiveTools(env, "session-1")).resolves.toEqual(new Set(["alpha", "beta"]));
  });

  it("reads skill status for the default qa agent", async () => {
    gatewayCall.mockResolvedValueOnce({
      skills: [{ name: "alpha", eligible: true }],
    });

    await expect(readSkillStatus(env)).resolves.toEqual([{ name: "alpha", eligible: true }]);
    const [method, params, options] = requireGatewayCall();
    expect(method).toBe("skills.status");
    expect(params).toEqual({ agentId: "qa" });
    expect(options?.timeoutMs).toBe(45_000);
  });

  it("retries transient FTS integrity mismatches while child transcripts settle", async () => {
    const readEntries = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error(
          'SQLite integrity_check failed for qa.sqlite: fts5: checksum mismatch for table "session_transcript_fts"',
        );
      })
      .mockReturnValueOnce([
        {
          sessionKey: "session-1",
          entry: { sessionId: "session-1", updatedAt: 10 },
        },
      ]);
    vi.useFakeTimers();

    const pending = readRawQaSessionStore(
      { gateway: { tempRoot: "/tmp/qa-fts-settle" } } as never,
      { readEntries, retryDelaysMs: [1] },
    );
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({
      "session-1": { sessionId: "session-1", updatedAt: 10 },
    });
    expect(readEntries).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an FTS integrity mismatch does not settle", async () => {
    const mismatch = new Error(
      'SQLite integrity_check failed for qa.sqlite: fts5: checksum mismatch for table "session_transcript_fts"',
    );
    const readEntries = vi.fn(() => {
      throw mismatch;
    });
    vi.useFakeTimers();

    const assertion = expect(
      readRawQaSessionStore({ gateway: { tempRoot: "/tmp/qa-fts-persistent" } } as never, {
        readEntries,
        retryDelaysMs: [1],
      }),
    ).rejects.toThrow(mismatch.message);
    await vi.runAllTimersAsync();

    await assertion;
    expect(readEntries).toHaveBeenCalledTimes(2);
  });

  it("seeds QA session metadata and transcript messages in SQLite", async () => {
    const tempRoot = await makeTempDir("qa-session-seed-");
    const sessionId = "seeded-session";
    const sessionKey = "agent:qa:seeded-session";

    await seedQaSessionTranscript(
      {
        gateway: { tempRoot },
      } as never,
      {
        sessionId,
        sessionKey,
        updatedAt: 300,
        label: "Seeded QA transcript",
        messages: [
          { role: "user", text: "What is the codename?", timestamp: 100 },
          { role: "assistant", text: "The codename is ORBIT-10.", timestamp: 200 },
        ],
      },
    );

    const sessionStore = await readRawQaSessionStore({
      gateway: { tempRoot },
    } as never);
    expect(sessionStore).toMatchObject({
      [sessionKey]: {
        sessionId,
        updatedAt: 300,
        origin: { label: "Seeded QA transcript" },
      },
    });
    const transcriptEvents = loadTranscriptEventsSync({
      agentId: "qa",
      env: qaSessionEnv(tempRoot),
      sessionId,
      sessionKey,
    });
    expect(
      transcriptEvents.flatMap((event) => {
        const message = (event as { message?: unknown }).message;
        return message ? [message] : [];
      }),
    ).toEqual([
      {
        role: "user",
        timestamp: 100,
        content: [{ type: "text", text: "What is the codename?" }],
      },
      {
        role: "assistant",
        timestamp: 200,
        content: [{ type: "text", text: "The codename is ORBIT-10." }],
      },
    ]);

    await expect(
      fs.stat(path.join(tempRoot, "state", "agents", "qa", "agent", "openclaw-agent.sqlite")),
    ).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(tempRoot, "state", "agents", "qa", "sessions", "sessions.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(tempRoot, "state", "agents", "qa", "sessions", `${sessionId}.jsonl`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("seeds multi-agent session entries through the canonical accessor", async () => {
    const tempRoot = await makeTempDir("qa-session-entry-seed-");
    const parentSessionKey = "agent:qa:main";

    await seedQaSessionEntries(
      {
        gateway: { tempRoot },
      } as never,
      [
        {
          agentId: "qa",
          sessionKey: parentSessionKey,
          entry: {
            sessionId: "session-main",
            updatedAt: 300,
          },
        },
        {
          agentId: "qa",
          sessionKey: "agent:qa:subagent:child",
          entry: {
            sessionId: "session-child",
            updatedAt: 200,
            spawnedBy: parentSessionKey,
            status: "done",
            endedAt: 250,
          },
        },
        {
          agentId: "claude",
          sessionKey: "agent:claude:acp:child",
          entry: {
            sessionId: "session-acp-child",
            updatedAt: 100,
            parentSessionKey,
          },
        },
      ],
    );

    await expect(
      readRawQaSessionStore({ gateway: { tempRoot } } as never, { agentId: "qa" }),
    ).resolves.toMatchObject({
      [parentSessionKey]: {
        sessionId: "session-main",
        updatedAt: 300,
      },
      "agent:qa:subagent:child": {
        sessionId: "session-child",
        updatedAt: 200,
        spawnedBy: parentSessionKey,
        status: "done",
        endedAt: 250,
      },
    });
    await expect(
      readRawQaSessionStore({ gateway: { tempRoot } } as never, { agentId: "claude" }),
    ).resolves.toMatchObject({
      "agent:claude:acp:child": {
        sessionId: "session-acp-child",
        updatedAt: 100,
        parentSessionKey,
      },
    });
  });

  it("reports bounded persisted compaction summaries", async () => {
    const tempRoot = await makeTempDir("qa-session-compaction-summaries-");
    const sessionId = "compaction-summary";
    const sessionKey = "agent:qa:compaction-summary";
    const summaries = Array.from({ length: 18 }, (_, index) => `summary-${index}`);
    const transcript = await createQaTranscript({ tempRoot, sessionId, sessionKey });

    let parentId: string | null = null;
    for (const [index, summary] of summaries.entries()) {
      const id = `compaction-${index}`;
      await appendSqliteSessionTranscriptEventForTest({
        agentId: "qa",
        env: qaSessionEnv(tempRoot),
        sessionId,
        sessionKey,
        event: {
          type: "compaction",
          id,
          parentId,
          timestamp: new Date(index).toISOString(),
          summary,
          firstKeptEntryId: id,
          tokensBefore: 100,
        },
      });
      parentId = id;
    }
    await transcript.append({ role: "assistant", content: "done" });

    const result = await transcript.read();

    expect(result.compactionSummaries).toEqual(summaries.slice(-16));
    expect(result.finalText).toBe("done");
  });

  it("rejects an empty QA session transcript seed", async () => {
    const tempRoot = await makeTempDir("qa-session-seed-empty-");

    await expect(
      seedQaSessionTranscript(
        {
          gateway: { tempRoot },
        } as never,
        {
          sessionId: "seeded-session",
          sessionKey: "agent:qa:seeded-session",
          updatedAt: 100,
          messages: [],
        },
      ),
    ).rejects.toThrow("requires at least one message");
  });

  it("summarizes a QA session transcript by session key", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-");
    const sessionKey = "agent:qa:webchat";
    const transcript = await createQaTranscript({ tempRoot, sessionKey, sessionId: "session-1" });
    await transcript.append({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "message",
          input: { action: "send", text: "hello" },
        },
      ],
      stopReason: "toolUse",
    });

    await expect(transcript.read()).resolves.toEqual({
      assistantToolCallCounts: { message: 1 },
      compactionSummaries: [],
      completedToolCallCounts: {},
      eventCursor: 2,
      userMessageCount: 0,
      successfulToolCallCounts: {},
      finalText: "",
      hasDirectReplySelfMessage: false,
      lastAssistantContentTypes: ["tool_use"],
      lastAssistantStopReason: "toolUse",
      lastAssistantToolNames: ["message"],
      lastMessageRole: "assistant",
    });

    await transcript.append({ role: "assistant", content: "Sent." });

    await expect(transcript.read()).resolves.toEqual({
      assistantToolCallCounts: { message: 1 },
      compactionSummaries: [],
      completedToolCallCounts: {},
      eventCursor: 3,
      userMessageCount: 0,
      successfulToolCallCounts: {},
      finalText: "Sent.",
      hasDirectReplySelfMessage: true,
      lastMessageRole: "assistant",
    });
  });

  it("summarizes QA transcript events after non-assistant rows", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-events-");
    const sessionKey = "agent:qa:stream";
    const transcript = await createQaTranscript({
      tempRoot,
      sessionKey,
      sessionId: "session-stream",
    });
    await transcript.append({ role: "user", content: "x".repeat(70 * 1024) });
    await transcript.append({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "message",
          input: { action: "send", text: "hello" },
        },
      ],
    });
    await transcript.append({
      role: "assistant",
      content: "Sent.",
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    });

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
    const tempRoot = await makeTempDir("qa-session-transcript-tool-results-");
    const sessionKey = "agent:qa:tool-results";
    const transcript = await createQaTranscript({
      tempRoot,
      sessionKey,
      sessionId: "session-tool-results",
    });
    await transcript.append({
      role: "assistant",
      content: [
        { type: "toolCall", id: "plan-ok", name: "progress_card", arguments: {} },
        { type: "toolCall", id: "plan-error", name: "progress_card", arguments: {} },
        { type: "toolCall", id: "write-mismatch", name: "write", arguments: {} },
      ],
    });
    for (const message of [
      {
        role: "toolResult",
        toolCallId: "plan-ok",
        toolName: "progress_card",
        content: [{ type: "text", text: "Progress card updated" }],
        isError: false,
        timestamp: 100,
      },
      {
        role: "toolResult",
        toolCallId: "plan-ok",
        toolName: "progress_card",
        content: [{ type: "text", text: "duplicate" }],
        isError: false,
        timestamp: 200,
      },
      {
        role: "toolResult",
        toolCallId: "plan-error",
        toolName: "progress_card",
        content: [{ type: "text", text: "failed" }],
        isError: true,
        timestamp: 300,
      },
      {
        role: "toolResult",
        toolCallId: "write-mismatch",
        toolName: "exec",
        content: [{ type: "text", text: "wrong tool" }],
        isError: false,
        timestamp: 400,
      },
    ]) {
      await transcript.append(message);
    }

    await expect(transcript.read()).resolves.toMatchObject({
      assistantToolCallCounts: { progress_card: 2, write: 1 },
      completedToolCallCounts: { progress_card: 2 },
      successfulToolCallCounts: { progress_card: 1 },
      successfulToolCallEvents: [{ name: "progress_card", timestamp: 100, toolCallId: "plan-ok" }],
    });
  });

  it("anchors a cutoff on the visible assistant reply where a serialized probe splits a tool call", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-reply-anchor-");
    const sessionKey = "agent:qa:reply-anchor";
    const sessionId = "session-reply-anchor";
    const marker = "PARENT_DONE:9f1";
    await seedQaSession({ tempRoot, sessionKey, sessionId });
    for (const message of [
      { role: "user", content: `reply with exactly ${marker}` },
      { role: "assistant", content: marker },
      {
        role: "assistant",
        content: [
          { type: "text", text: `${marker} is out; delivering the completion now` },
          { type: "toolCall", id: "send-1", name: "message", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "send-1",
        toolName: "message",
        content: [{ type: "text", text: "sent" }],
        isError: false,
        timestamp: 500,
      },
    ]) {
      await appendQaTranscriptMessage({ tempRoot, sessionKey, sessionId, message });
    }
    const transcriptEnv = { gateway: { tempRoot } } as never;

    const anchors = await readSessionTranscriptSummary(transcriptEnv, sessionKey, {
      assistantReplyText: marker,
      probeText: marker,
    });
    // The serialized probe lands on the later event that only quotes the marker,
    // and that event is the one carrying the invocation.
    expect(Number.isInteger(anchors.assistantReplyStartLine)).toBe(true);
    expect(anchors.probeTextEndLine).toBeGreaterThan(Number(anchors.assistantReplyStartLine));

    await expect(
      readSessionTranscriptSummary(transcriptEnv, sessionKey, {
        afterEventCursor: anchors.assistantReplyStartLine,
      }),
    ).resolves.toMatchObject({ successfulToolCallCounts: { message: 1 } });
    await expect(
      readSessionTranscriptSummary(transcriptEnv, sessionKey, {
        afterEventCursor: anchors.probeTextEndLine,
      }),
    ).resolves.toMatchObject({ successfulToolCallCounts: {} });
  });

  it("counts Code Mode nested tool activity as the target tool's completed result", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-nested-tool-");
    const sessionKey = "agent:qa:nested-tool";
    const sessionId = "session-nested-tool";
    const transcript = await createQaTranscript({ tempRoot, sessionKey, sessionId });
    const execCallId = "call_mock_exec_1|fc_mock_exec_1";
    const nestedActivity = (toolCallId: string, isError: boolean) => ({
      role: "custom",
      customType: "openclaw.nested-tool.v1",
      display: true,
      excludeFromContext: true,
      content: "",
      details: {
        runId: "run-1",
        scopeId: "scope-1",
        afterEntryId: null,
        startOrder: 0,
        parentToolCallId: execCallId,
        toolCallId,
        toolName: "web_fetch",
        input: { url: "https://example.com/" },
        result: { content: [{ type: "text", text: "{}" }] },
        isError,
        startedAt: 100,
        timestamp: 150,
      },
      timestamp: 150,
    });
    for (const message of [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: execCallId, name: "exec", arguments: { code: "" } }],
      },
      nestedActivity("nested-ok", false),
      nestedActivity("nested-failed", true),
      {
        role: "toolResult",
        toolCallId: execCallId,
        toolName: "exec",
        content: [{ type: "text", text: '{"status":"completed"}' }],
        isError: false,
        timestamp: 200,
      },
    ]) {
      await transcript.append(message);
    }

    await expect(transcript.read()).resolves.toMatchObject({
      assistantToolCallCounts: { exec: 1, web_fetch: 2 },
      completedToolCallCounts: { exec: 1, web_fetch: 2 },
      successfulToolCallCounts: { exec: 1, web_fetch: 1 },
      successfulToolCallEvents: [
        { name: "web_fetch", timestamp: 150, toolCallId: "nested-ok" },
        { name: "exec", timestamp: 200, toolCallId: execCallId },
      ],
    });
  });

  it("matches pending Code Mode waits to the exec checkpoint that created their run", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-code-mode-wait-");
    const sessionKey = "agent:qa:code-mode-wait";
    const sessionId = "session-code-mode-wait";
    const transcript = await createQaTranscript({ tempRoot, sessionKey, sessionId });

    for (const message of [
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
    ]) {
      await transcript.append(message);
    }

    await expect(
      transcript.read({
        pendingCodeModeExecNeedle: "CHECKPOINT-1",
      }),
    ).resolves.toMatchObject({ hasPendingCodeModeWait: false });

    for (const message of [
      assistantToolCall("checkpoint-2-exec", "exec", {
        code: "await qa_restart_wait(); return 'CHECKPOINT-2';",
      }),
      toolResult("checkpoint-2-exec", "exec", { status: "waiting", runId: "checkpoint-2-run" }),
      assistantToolCall("checkpoint-2-wait", "wait", { runId: "checkpoint-2-run" }),
    ]) {
      await transcript.append(message);
    }

    await expect(
      transcript.read({
        pendingCodeModeExecNeedle: "CHECKPOINT-2",
      }),
    ).resolves.toMatchObject({ hasPendingCodeModeWait: true });
  });

  it("only exposes authenticated successful tool results with finite owner timestamps", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-tool-event-timestamps-");
    const sessionKey = "agent:qa:tool-event-timestamps";
    const sessionId = "session-tool-event-timestamps";
    const transcript = await createQaTranscript({ tempRoot, sessionKey, sessionId });
    await transcript.append({
      role: "assistant",
      content: ["missing", "invalid", "valid"].map((id) => ({
        type: "toolCall",
        id,
        name: "exec",
        arguments: {},
      })),
    });

    for (const [toolCallId, timestamp] of [
      ["missing", undefined],
      ["invalid", "not-a-number"],
      ["valid", 300],
    ] as const) {
      await transcript.append({
        role: "toolResult",
        toolCallId,
        toolName: "exec",
        isError: false,
        ...(timestamp === undefined ? {} : { timestamp }),
      });
    }

    await expect(transcript.read()).resolves.toMatchObject({
      successfulToolCallCounts: { exec: 3 },
      successfulToolCallEvents: [{ name: "exec", timestamp: 300, toolCallId: "valid" }],
    });
  });

  it("bounds authenticated successful tool results to the latest 64 events", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-tool-event-bound-");
    const sessionKey = "agent:qa:tool-event-bound";
    const sessionId = "session-tool-event-bound";
    const transcript = await createQaTranscript({ tempRoot, sessionKey, sessionId });
    await transcript.append({
      role: "assistant",
      content: Array.from({ length: 65 }, (_, index) => ({
        type: "toolCall",
        id: `call-${index}`,
        name: "exec",
        arguments: {},
      })),
    });

    for (let index = 0; index < 65; index += 1) {
      await transcript.append({
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "exec",
        isError: false,
        timestamp: index,
      });
    }

    const summary = await transcript.read();

    expect(summary.successfulToolCallCounts).toEqual({ exec: 65 });
    expect(summary.successfulToolCallEvents).toHaveLength(64);
    expect(summary.successfulToolCallEvents?.[0]).toEqual({
      name: "exec",
      timestamp: 1,
      toolCallId: "call-1",
    });
    expect(summary.successfulToolCallEvents?.at(-1)).toEqual({
      name: "exec",
      timestamp: 64,
      toolCallId: "call-64",
    });
  });

  it("reports current-source delivery facts from runtime-only tool result details", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-current-source-");
    const sessionKey = "agent:qa:current-source";
    const sessionId = "session-current-source";
    const transcript = await createQaTranscript({ tempRoot, sessionKey, sessionId });
    await transcript.append({
      role: "toolResult",
      toolCallId: "message-1",
      toolName: "message",
      content: [{ type: "text", text: '{"ok":true}' }],
      details: {
        sourceReplyRoute: "current-source",
        receipt: { threadId: "thread-1" },
      },
      isError: false,
    });

    await expect(transcript.read()).resolves.toMatchObject({
      currentSourceToolDeliveries: [{ toolName: "message", threadId: "thread-1" }],
    });
  });

  it("scopes transcript evidence after an event cursor", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-cursor-");
    const sessionKey = "agent:qa:cursor";
    const sessionId = "session-cursor";
    const transcript = await createQaTranscript({ tempRoot, sessionKey, sessionId });
    for (const message of [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "old-plan", name: "progress_card", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "old-plan",
        toolName: "progress_card",
        content: [{ type: "text", text: "Progress card updated" }],
        isError: false,
        timestamp: 100,
      },
      {
        role: "assistant",
        content: "same visible reply",
        __openclaw: { mirrorIdentity: "old-turn:assistant" },
      },
    ]) {
      await transcript.append(message);
    }
    const checkpoint = await transcript.read();
    expect(checkpoint.successfulToolCallEvents).toEqual([
      { name: "progress_card", timestamp: 100, toolCallId: "old-plan" },
    ]);
    await transcript.append({
      role: "assistant",
      content: "same visible reply",
      __openclaw: { mirrorIdentity: "current-turn:assistant" },
    });

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
    const tempRoot = await makeTempDir("qa-session-transcript-checkpoint-");

    await expect(
      readSessionTranscriptSummary({ gateway: { tempRoot } } as never, "agent:qa:not-created-yet", {
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
    const tempRoot = await makeTempDir("qa-session-transcript-empty-");
    const transcript = await createQaTranscript({
      tempRoot,
      sessionKey: "agent:qa:empty",
      sessionId: "session-empty",
    });

    await expect(transcript.read()).rejects.toThrow("session transcript is empty");
  });

  it("fails closed when a requested QA session transcript entry is missing", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-missing-");

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        "agent:qa:missing",
      ),
    ).rejects.toThrow("session transcript entry not found");
  });
});
