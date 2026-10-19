// Codex tests cover SQLite-only trajectory plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  useSessionStoreTempDirs,
  appendSqliteTrajectoryRuntimeEvents,
  createTrajectoryRuntimeRecorderForTest,
  exportTrajectoryBundleForTest,
  loadSqliteTrajectoryRuntimeEvents,
  type SqliteTrajectoryRuntimeEventForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CodexDynamicToolFunctionSpec } from "./protocol.js";
import {
  createCodexTrajectoryRecorder,
  recordCodexTrajectoryCompletion,
  recordCodexTrajectoryContext,
  type CodexTrajectoryRecorder,
} from "./trajectory.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-trajectory-");
let tempDir: string;

beforeEach(() => {
  tempDir = sessionDirs.make();
});

function expectTrajectoryRecorder(
  recorder: ReturnType<typeof createCodexTrajectoryRecorder>,
): CodexTrajectoryRecorder {
  if (recorder === null) {
    throw new Error("Expected Codex trajectory recorder");
  }
  return recorder;
}

function tool(name: string, description: string): CodexDynamicToolFunctionSpec {
  return { type: "function", name, description, inputSchema: { type: "object" } };
}

function createSqliteTrajectoryFacade(params: {
  agentId: string;
  sessionId: string;
  storePath: string;
}): CodexTrajectoryRecorder {
  const events: SqliteTrajectoryRuntimeEventForTest[] = [];
  let seq = 0;
  return {
    recordEvent: (type, data) => {
      events.push({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: `${params.sessionId}:test`,
        source: "runtime",
        type,
        ts: new Date(0).toISOString(),
        seq,
        sessionId: params.sessionId,
        ...(data === undefined ? {} : { data }),
      });
      seq += 1;
    },
    flush: async () => {
      appendSqliteTrajectoryRuntimeEvents(params, events);
      events.length = 0;
    },
  };
}

async function createSessionTarget() {
  const target = {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    storePath: path.join(tempDir, "sessions", "sessions.json"),
  };
  await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 10 } });
  return target;
}

describe("Codex trajectory recorder", () => {
  it("returns null when the host trajectory facade is unavailable", () => {
    expect(createCodexTrajectoryRecorder(undefined)).toBeNull();
  });

  it("stores SQLite-backed captures for the canonical session-key target", async () => {
    // Regression: the host stopped emitting legacy `sqlite:` session-file
    // markers, so any marker re-derivation here drops every Codex capture.
    const target = await createSessionTarget();
    const recorder = createCodexTrajectoryRecorder(createSqliteTrajectoryFacade(target));

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("session.started");
    await trajectoryRecorder.flush();

    expect(fs.readdirSync(path.dirname(target.storePath))).not.toEqual(
      expect.arrayContaining(["session.trajectory.jsonl", "session.trajectory-path.json"]),
    );
    await expect(loadSqliteTrajectoryRuntimeEvents(target)).resolves.toEqual([
      expect.objectContaining({ type: "session.started" }),
    ]);
  });

  it("records namespace dynamic tools as callable trajectory definitions", async () => {
    const tools = [
      {
        type: "namespace" as const,
        name: "openclaw",
        description: "",
        tools: [{ ...tool("web_search", "Search the web."), deferLoading: true }],
      },
    ];
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const recorder = expectTrajectoryRecorder(
      createCodexTrajectoryRecorder({
        recordEvent: (type, data) => events.push({ type, data }),
        flush: async () => undefined,
      }),
    );

    recordCodexTrajectoryContext(recorder, { attempt: {} as never, tools });
    await recorder.flush();

    expect(events[0]?.data?.tools).toEqual([
      {
        name: "web_search",
        description: "Search the web.",
        parameters: { type: "object" },
      },
    ]);
  });

  it("lets the host bound oversized Codex events without losing terminal facts", async () => {
    const tmpDir = tempDir;
    const sessionTarget = await createSessionTarget();
    const attempt = {
      agentId: "main",
      cwd: tmpDir,
      workspaceDir: tmpDir,
      sessionFile: sessionTarget.sessionKey,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      provider: "codex",
      modelId: "gpt-5.4",
      model: { api: "responses" },
    };
    const usage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    const hostRecorder = await createTrajectoryRuntimeRecorderForTest({
      sessionId: sessionTarget.sessionId,
      sessionKey: sessionTarget.sessionKey,
      sessionTarget,
      runId: attempt.runId,
      provider: "openai",
      modelId: attempt.modelId,
      modelApi: "responses",
      workspaceDir: tmpDir,
    });
    if (!hostRecorder) {
      throw new Error("Expected host trajectory recorder");
    }
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: { ...attempt, trajectoryRecorder: hostRecorder } as never,
      pluginId: "codex",
    });
    const recorder = createCodexTrajectoryRecorder(host.capabilities.trajectory);
    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    // Twelve entries fit the old plugin cap but exceed the host's unshrunk event cap.
    const messagesSnapshot = () =>
      Array.from({ length: 12 }, (_value, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(32_000)}`,
      }));
    const terminal = (error: string) => ({
      kind: "timeout",
      phase: "prompt",
      source: "runtime",
      aborted: true,
      failure: { source: "prompt", error },
    });

    try {
      recordCodexTrajectoryContext(trajectoryRecorder, {
        attempt: attempt as never,
        developerInstructions: `Bearer ${"s".repeat(40)} ${"x".repeat(40_000)}`,
        prompt: "inspect",
        tools: [tool("huge_tool", "x".repeat(40_000))],
      } as never);
      trajectoryRecorder.recordEvent("tool.result", {
        toolCallId: "call-1",
        toolName: "huge_tool",
        status: "completed",
        authorization: `Bearer ${"t".repeat(40)}`,
        output: `token=${"t".repeat(40)} ${"x".repeat(40_000)}`,
      });
      recordCodexTrajectoryCompletion(trajectoryRecorder, {
        threadId: "thread-1",
        turnId: "turn-1",
        timedOut: true,
        yieldDetected: true,
        result: {
          terminal: terminal("terminal prompt error"),
          attemptUsage: usage,
          assistantTexts: ["done"],
          messagesSnapshot: messagesSnapshot(),
        } as never,
      });
      recordCodexTrajectoryCompletion(trajectoryRecorder, {
        threadId: "thread-compact",
        turnId: "turn-compact",
        timedOut: true,
        result: {
          terminal: terminal("compact prompt error"),
          attemptUsage: usage,
          assistantTexts: Array.from(
            { length: 12 },
            (_value, index) => `assistant-${index} ${"x".repeat(32_000)}`,
          ),
          messagesSnapshot: messagesSnapshot(),
        } as never,
      });
      await trajectoryRecorder.flush();
    } finally {
      host.close();
    }

    const events = await loadSqliteTrajectoryRuntimeEvents(sessionTarget);
    const fieldLimit = { truncated: true, reason: "trajectory-field-size-limit" };
    const completionFacts = {
      truncated: true,
      reason: "trajectory-event-size-limit",
      timedOut: true,
      aborted: true,
      usage,
    };
    const context = events.find((event) => event.type === "context.compiled");
    const toolResult = events.find((event) => event.type === "tool.result");
    const completion = events.find(
      (event) => event.type === "model.completed" && event.data?.turnId === "turn-1",
    );
    const compactCompletion = events.find(
      (event) => event.type === "model.completed" && event.data?.turnId === "turn-compact",
    );
    expect(context?.data).toMatchObject({
      prompt: "inspect",
      systemPrompt: fieldLimit,
      tools: [
        {
          name: "huge_tool",
          description: fieldLimit,
          parameters: { type: "object" },
        },
      ],
    });
    expect(JSON.stringify(context)).not.toContain("s".repeat(40));
    expect(toolResult?.data).toMatchObject({
      toolCallId: "call-1",
      toolName: "huge_tool",
      status: "completed",
      output: fieldLimit,
    });
    expect(toolResult?.data?.authorization).toBe(`Bearer ${"t".repeat(40)}`);
    expect(JSON.stringify(toolResult)).not.toContain(`token=${"t".repeat(40)}`);
    expect(completion?.data).toMatchObject({
      ...completionFacts,
      threadId: "thread-1",
      turnId: "turn-1",
      yieldDetected: true,
      promptError: "terminal prompt error",
      assistantTexts: ["done"],
    });
    expect(completion?.data?.messagesSnapshot).toBeUndefined();
    expect(completion?.data?.droppedFields).toEqual(["messagesSnapshot"]);
    expect(compactCompletion?.data).toMatchObject({
      ...completionFacts,
      threadId: "thread-compact",
      turnId: "turn-compact",
      yieldDetected: false,
      promptError: "compact prompt error",
    });
    expect(compactCompletion?.data?.assistantTexts).toBeUndefined();
    expect(compactCompletion?.data?.messagesSnapshot).toBeUndefined();
    expect(compactCompletion?.data?.droppedFields).toEqual(["assistantTexts", "messagesSnapshot"]);

    const bundle = await exportTrajectoryBundleForTest({
      outputDir: path.join(tmpDir, "bundle"),
      sessionTarget,
      sessionId: sessionTarget.sessionId,
      sessionKey: sessionTarget.sessionKey,
      workspaceDir: tmpDir,
    });
    const exported = (turnId: string) =>
      bundle.events.find(
        (event) => event.type === "model.completed" && event.data?.turnId === turnId,
      )?.data;
    expect(exported("turn-1")).toEqual(completion?.data);
    expect(exported("turn-compact")).toEqual(compactCompletion?.data);
  });
});
