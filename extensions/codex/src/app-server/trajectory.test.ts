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
import { afterAll, describe, expect, it } from "vitest";
import {
  createCodexTrajectoryRecorder,
  recordCodexTrajectoryCompletion,
  recordCodexTrajectoryContext,
} from "./trajectory.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-trajectory-");

describe("Codex trajectory recorder", () => {
  it("returns null when the host trajectory facade is unavailable", () => {
    expect(createCodexTrajectoryRecorder(undefined)).toBeNull();
  });

  it("stores context and terminal facts in SQLite for the canonical session-key target", async () => {
    // Regression: the host stopped emitting legacy `sqlite:` session-file
    // markers, so any marker re-derivation here drops every Codex capture.
    const tempDir = sessionDirs.make();
    const target = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath: path.join(tempDir, "sessions", "sessions.json"),
    };
    await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 10 } });
    const trajectoryRecorder = expectDefined(
      await createTrajectoryRuntimeRecorderForTest({
        ...target,
        sessionTarget: target,
        runId: "run-1",
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "responses",
        workspaceDir: tempDir,
      }),
      "host trajectory recorder",
    );
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: {
        ...target,
        runId: "run-1",
        config: {},
        trajectoryRecorder,
      },
      pluginId: "codex",
    });
    const usage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    const messagesSnapshot = [{ role: "user", content: "inspect" }];
    try {
      const recorder = expectDefined(
        createCodexTrajectoryRecorder(host.capabilities.trajectory),
        "Codex trajectory recorder",
      );
      recorder.recordEvent("session.started");
      recordCodexTrajectoryContext(recorder, {
        attempt: {} as never,
        tools: [
          {
            type: "namespace",
            name: "openclaw",
            description: "",
            tools: [
              {
                type: "function",
                name: "web_search",
                description: "Search the web.",
                inputSchema: { type: "object" },
                deferLoading: true,
              },
            ],
          },
        ],
        developerInstructions: "Developer instructions",
        prompt: "inspect",
      });
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
    } finally {
      host.close();
    }

    expect(fs.readdirSync(path.dirname(target.storePath))).not.toEqual(
      expect.arrayContaining(["session.trajectory.jsonl", "session.trajectory-path.json"]),
    );
    const [started, context, ...completed] = await loadSqliteTrajectoryRuntimeEvents(target);
    expect(started).toMatchObject({ type: "session.started" });
    expect(context).toMatchObject({ type: "context.compiled" });
    expect(context?.data).toEqual({
      systemPrompt: "Developer instructions",
      prompt: "inspect",
      imagesCount: 0,
      tools: [
        { name: "web_search", description: "Search the web.", parameters: { type: "object" } },
      ],
    });
    expect(completed).toMatchObject(
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
