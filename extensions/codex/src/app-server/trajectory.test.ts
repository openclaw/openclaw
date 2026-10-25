import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  useSessionStoreTempDirs,
  createTrajectoryRuntimeRecorderForTest,
  loadSqliteTrajectoryRuntimeEvents,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CodexDynamicToolFunctionSpec } from "./protocol.js";
import {
  createCodexTrajectoryRecorder,
  recordCodexTrajectoryCompletion,
  recordCodexTrajectoryContext,
} from "./trajectory.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-trajectory-");
let tempDir: string;

beforeEach(() => {
  tempDir = sessionDirs.make();
});

function tool(name: string, description: string): CodexDynamicToolFunctionSpec {
  return { type: "function", name, description, inputSchema: { type: "object" } };
}

async function createHostRecorder(sessionTarget: Awaited<ReturnType<typeof createSessionTarget>>) {
  return expectDefined(
    await createTrajectoryRuntimeRecorderForTest({
      ...sessionTarget,
      sessionTarget,
      runId: "run-1",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      workspaceDir: tempDir,
    }),
    "host trajectory recorder",
  );
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
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: {
        ...target,
        runId: "run-1",
        config: {},
        trajectoryRecorder: await createHostRecorder(target),
      },
      pluginId: "codex",
    });
    try {
      const recorder = expectDefined(
        createCodexTrajectoryRecorder(host.capabilities.trajectory),
        "Codex trajectory recorder",
      );
      recorder.recordEvent("session.started");
      await recorder.flush();
    } finally {
      host.close();
    }

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
    const recorder = expectDefined(
      createCodexTrajectoryRecorder({
        recordEvent: (type, data) => events.push({ type, data }),
        flush: async () => undefined,
      }),
      "Codex trajectory recorder",
    );

    recordCodexTrajectoryContext(recorder, {
      attempt: {} as never,
      tools,
      developerInstructions: "Developer instructions",
      prompt: "inspect",
    });
    await recorder.flush();

    expect(events).toEqual([
      {
        type: "context.compiled",
        data: {
          systemPrompt: "Developer instructions",
          prompt: "inspect",
          imagesCount: 0,
          tools: [
            { name: "web_search", description: "Search the web.", parameters: { type: "object" } },
          ],
        },
      },
    ]);
  });

  it("forwards terminal facts to the host recorder with explicit and default yield state", async () => {
    const target = await createSessionTarget();
    const recorder = expectDefined(
      createCodexTrajectoryRecorder(await createHostRecorder(target)),
      "Codex trajectory recorder",
    );
    const usage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    const messagesSnapshot = [{ role: "user", content: "inspect" }];
    for (const yieldDetected of [true, undefined]) {
      recordCodexTrajectoryCompletion(recorder, {
        threadId: "thread-1",
        turnId: "turn-1",
        timedOut: true,
        yieldDetected,
        result: {
          terminal: {
            kind: "timeout",
            phase: "prompt",
            source: "runtime",
            aborted: true,
            failure: { source: "prompt", error: "terminal prompt error" },
          },
          attemptUsage: usage,
          assistantTexts: ["done"],
          messagesSnapshot,
        } as never,
      });
    }
    await recorder.flush();
    expect(await loadSqliteTrajectoryRuntimeEvents(target)).toMatchObject(
      [true, false].map((yieldDetected) => ({
        type: "model.completed",
        data: {
          threadId: "thread-1",
          turnId: "turn-1",
          timedOut: true,
          yieldDetected,
          aborted: true,
          promptError: "terminal prompt error",
          usage,
          assistantTexts: ["done"],
          messagesSnapshot,
        },
      })),
    );
  });
});
