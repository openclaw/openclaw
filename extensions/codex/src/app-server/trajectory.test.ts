import fs from "node:fs";
import path from "node:path";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  useSessionStoreTempDirs,
  createTrajectoryRuntimeRecorderForTest,
  exportTrajectoryBundleForTest,
  loadSqliteTrajectoryRuntimeEvents,
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

async function createHostRecorder(sessionTarget: Awaited<ReturnType<typeof createSessionTarget>>) {
  const recorder = await createTrajectoryRuntimeRecorderForTest({
    ...sessionTarget,
    sessionTarget,
    runId: "run-1",
    provider: "openai",
    modelId: "gpt-5.4",
    modelApi: "responses",
    workspaceDir: tempDir,
  });
  if (!recorder) {
    throw new Error("Expected host trajectory recorder");
  }
  return recorder;
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
    const trajectoryRecorder = expectTrajectoryRecorder(
      createCodexTrajectoryRecorder(await createHostRecorder(target)),
    );
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
    const sessionTarget = await createSessionTarget();
    const attempt = {
      agentId: "main",
      cwd: tempDir,
      workspaceDir: tempDir,
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
    const hostRecorder = await createHostRecorder(sessionTarget);
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: { ...attempt, trajectoryRecorder: hostRecorder } as never,
      pluginId: "codex",
    });
    const trajectoryRecorder = expectTrajectoryRecorder(
      createCodexTrajectoryRecorder(host.capabilities.trajectory),
    );
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
    const complete = (
      suffix: string,
      assistantTexts: string[],
      error: string,
      yieldDetected?: boolean,
    ) =>
      recordCodexTrajectoryCompletion(trajectoryRecorder, {
        threadId: `thread-${suffix}`,
        turnId: `turn-${suffix}`,
        timedOut: true,
        yieldDetected,
        result: {
          terminal: terminal(error),
          attemptUsage: usage,
          assistantTexts,
          messagesSnapshot: messagesSnapshot(),
        } as never,
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
      complete("1", ["done"], "terminal prompt error", true);
      complete(
        "compact",
        Array.from({ length: 12 }, (_value, index) => `assistant-${index} ${"x".repeat(32_000)}`),
        "compact prompt error",
      );
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
    const eventData = (type: string, turnId?: string) =>
      events.find((event) => event.type === type && (!turnId || event.data?.turnId === turnId))
        ?.data;
    const context = eventData("context.compiled");
    const toolResult = eventData("tool.result");
    const completion = eventData("model.completed", "turn-1");
    const compactCompletion = eventData("model.completed", "turn-compact");
    expect(context).toMatchObject({
      prompt: "inspect",
      systemPrompt: fieldLimit,
      tools: [{ name: "huge_tool", description: fieldLimit, parameters: { type: "object" } }],
    });
    expect(JSON.stringify(context)).not.toContain("s".repeat(40));
    expect(toolResult).toMatchObject({
      toolCallId: "call-1",
      toolName: "huge_tool",
      status: "completed",
      output: fieldLimit,
      authorization: `Bearer ${"t".repeat(40)}`,
    });
    expect(JSON.stringify(toolResult)).not.toContain(`token=${"t".repeat(40)}`);
    expect(completion).toMatchObject({
      ...completionFacts,
      threadId: "thread-1",
      turnId: "turn-1",
      yieldDetected: true,
      promptError: "terminal prompt error",
      assistantTexts: ["done"],
    });
    expect(completion?.messagesSnapshot).toBeUndefined();
    expect(completion?.droppedFields).toEqual(["messagesSnapshot"]);
    expect(compactCompletion).toMatchObject({
      ...completionFacts,
      threadId: "thread-compact",
      turnId: "turn-compact",
      yieldDetected: false,
      promptError: "compact prompt error",
    });
    expect(compactCompletion?.assistantTexts).toBeUndefined();
    expect(compactCompletion?.messagesSnapshot).toBeUndefined();
    expect(compactCompletion?.droppedFields).toEqual(["assistantTexts", "messagesSnapshot"]);

    const bundle = await exportTrajectoryBundleForTest({
      outputDir: path.join(tempDir, "bundle"),
      sessionTarget,
      sessionId: sessionTarget.sessionId,
      sessionKey: sessionTarget.sessionKey,
      workspaceDir: tempDir,
    });
    const exported = (turnId: string) =>
      bundle.events.find(
        (event) => event.type === "model.completed" && event.data?.turnId === turnId,
      )?.data;
    expect(exported("turn-1")).toEqual(completion);
    expect(exported("turn-compact")).toEqual(compactCompletion);
  });
});
