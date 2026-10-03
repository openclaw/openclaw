// Qa Lab tests cover suite runtime agent session plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
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

const { cleanup, makeTempDir } = createTempDirHarness({
  beforeCleanup: closeQaRuntimeStores,
});

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterAll(cleanup);

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
    const transcript = await createQaTranscript({ tempRoot, sessionKey, sessionId });
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
      await transcript.append(message);
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
        startOrder: toolCallId === "nested-ok" ? 0 : 1,
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
      nestedActivity("nested-failed", true),
      nestedActivity("nested-ok", false),
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
      assistantToolCallCounts: { web_fetch: 2 },
      completedToolCallCounts: { web_fetch: 2 },
      successfulToolCallCounts: { web_fetch: 1 },
      successfulToolCallEvents: [{ name: "web_fetch", timestamp: 150, toolCallId: "nested-ok" }],
    });
    const activity = await readSessionToolActivity({ gateway: { tempRoot } }, sessionKey);
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
    const tempRoot = await makeTempDir("qa-session-transcript-shell-accounting-");
    const transcript = await createQaTranscript({
      tempRoot,
      sessionKey: "agent:qa:shell-accounting",
      sessionId: "session-shell-accounting",
    });
    for (const [index, exitCode] of [1, 0, 0].entries()) {
      const wrapperId = `wrapper-${index}`;
      await transcript.append(
        assistantToolCall(wrapperId, "exec", { code: "await exec({ command: 'proof' });" }),
      );
      const nested = {
        role: "custom",
        customType: "openclaw.nested-tool.v1",
        display: true,
        excludeFromContext: true,
        content: "",
        details: {
          runId: "run-shell",
          scopeId: `scope-${index}`,
          afterEntryId: null,
          startOrder: 0,
          parentToolCallId: wrapperId,
          toolCallId: `shell-${index}`,
          toolName: "exec",
          input: { command: "proof" },
          result: { content: [], details: { status: "completed", exitCode } },
          isError: false,
          startedAt: 100 + index * 10,
          timestamp: 105 + index * 10,
        },
        timestamp: 105 + index * 10,
      };
      await transcript.append(nested);
      await transcript.append(nested);
      await transcript.append({
        ...toolResult(wrapperId, "exec", { status: "completed" }),
        timestamp: 109 + index * 10,
      });
    }
    await transcript.append(assistantToolCall("direct-failed", "exec", { command: "proof" }));
    await transcript.append({
      ...toolResult("direct-failed", "exec", { status: "completed", exitCode: 1 }),
      timestamp: 200,
    });

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
    const tempRoot = await makeTempDir("qa-session-transcript-causal-tools-");
    const sessionKey = "agent:qa:causal-tools";
    const transcript = await createQaTranscript({
      tempRoot,
      sessionKey,
      sessionId: "session-causal-tools",
    });
    const wrapper = await transcript.append({
      ...assistantToolCall("wrapper", "exec", { code: "dispatch task tools" }),
      timestamp: 100,
    });
    if (!wrapper) {
      throw new Error("missing persisted wrapper");
    }
    const appendNested = (toolCallId: string, startOrder: number, afterEntryId: string) =>
      transcript.append({
        role: "custom",
        customType: "openclaw.nested-tool.v1",
        display: true,
        excludeFromContext: true,
        content: "",
        timestamp: 100,
        details: {
          runId: "causal-run",
          scopeId: "causal-scope",
          afterEntryId,
          startOrder,
          parentToolCallId: "wrapper",
          toolCallId,
          toolName: "read",
          input: { path: "task.md" },
          result: { content: [{ type: "text", text: "completed" }] },
          isError: false,
          startedAt: 100,
          timestamp: 100,
        },
      });
    await appendNested("first", 0, wrapper.messageId);
    const overlap = await appendNested("overlap", 1, wrapper.messageId);
    if (!overlap) {
      throw new Error("missing persisted overlapping result");
    }
    await appendNested("serial", 2, overlap.messageId);

    const activity = await readSessionToolActivity({ gateway: { tempRoot } }, sessionKey);
    const [wrapperActivity, firstActivity, overlapActivity, serialActivity] = activity;
    if (!wrapperActivity || !firstActivity || !overlapActivity || !serialActivity) {
      throw new Error("missing projected causal tool activity");
    }
    expect(activity).toMatchObject([
      { toolCallId: "wrapper", startAfterIndex: wrapperActivity.callIndex - 1 },
      { toolCallId: "first", startAfterIndex: wrapperActivity.callIndex },
      { toolCallId: "overlap", startAfterIndex: wrapperActivity.callIndex },
      { toolCallId: "serial", startAfterIndex: overlapActivity.resultIndex },
    ]);
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

  it.each(["guest", "native-text", "native-blocks"] as const)(
    "separates %s cell controls from unmatched waits and physical exec",
    async (dialect) => {
      const tempRoot = await makeTempDir("qa-session-transcript-cell-controls-");
      const sessionKey = "agent:qa:cell-controls";
      const transcript = await createQaTranscript({
        tempRoot,
        sessionKey,
        sessionId: "session-cell-controls",
      });
      const native = dialect !== "guest";
      const waitInput = (id: string) =>
        native ? { arguments: JSON.stringify({ cell_id: id }) } : { runId: id };
      const header = "Script running with cell ID cell-owned\nWall time 0.1 seconds\nOutput:\n";
      const wrapperText =
        dialect === "native-blocks"
          ? JSON.stringify([{ type: "input_text", text: header }])
          : header;
      for (const message of [
        assistantToolCall(
          "wrapper",
          "exec",
          native ? { input: "await work();" } : { code: "await work();" },
        ),
        assistantToolCall("early-wait", "wait", waitInput("cell-owned")),
        toolResult("early-wait", "wait", {}),
        {
          ...toolResult(
            "wrapper",
            "exec",
            native ? {} : { status: "waiting", runId: "cell-owned" },
          ),
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
      ]) {
        await transcript.append(message);
      }
      const summary = await transcript.read();
      expect(summary.assistantToolCallCounts).toEqual({ exec: 1, wait: 2 });
      expect(summary.successfulToolCallCounts).toEqual({ exec: 1, wait: 2 });
      const activity = await readSessionToolActivity({ gateway: { tempRoot } }, sessionKey);
      expect(
        activity.filter((call) => call.kind === "code-mode-control").map((call) => call.toolCallId),
      ).toEqual(["wrapper", "matched-wait"]);
      const wireSummary = await transcript.read({ includeCodeModeControl: true });
      expect(wireSummary.assistantToolCallCounts).toEqual({ exec: 2, wait: 3 });
    },
  );

  it("rejects ambiguous receipts and unfinished shell polls while preserving domain statuses", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-outcomes-");
    const transcript = await createQaTranscript({
      tempRoot,
      sessionKey: "agent:qa:outcomes",
      sessionId: "session-outcomes",
    });
    for (const [id, name, input, details] of [
      ["running", "process", { action: "poll" }, { status: "running" }],
      ["failed", "process", { action: "poll" }, { status: "completed", exitCode: 1 }],
      ["ok", "process", { action: "poll" }, { status: "completed", exitCode: 0 }],
      ["write", "process", { action: "write" }, { status: "running" }],
      ["domain", "progress_card", {}, { status: "running" }],
      ["unavailable", "exec", { command: "proof" }, { status: "unavailable" }],
      [
        "gateway-failed",
        "gateway_exec",
        { command: "proof" },
        { status: "completed", exitCode: 1 },
      ],
      ["gateway-poll", "gateway_process", { action: "poll" }, { status: "running" }],
      ["conflict", "exec", { command: "proof" }, { status: "completed", exitCode: 0 }],
    ] as const) {
      await transcript.append(assistantToolCall(id, name, input));
      await transcript.append({ ...toolResult(id, name, details), timestamp: 100 });
    }
    await transcript.append({
      ...toolResult("conflict", "exec", { status: "completed", exitCode: 1 }),
      timestamp: 101,
    });
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
