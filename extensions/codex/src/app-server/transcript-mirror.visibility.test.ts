import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  buildEmptyToolTelemetry,
  createParams,
  forCurrentTurn,
  registerCodexEventProjectorTestLifecycle,
  turnCompleted,
} from "./event-projector.test-harness.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import {
  codexTranscriptMirrorRuntime,
  mirrorPromptAtTurnStartBestEffort,
} from "./transcript-mirror.js";

registerCodexEventProjectorTestLifecycle();

it.each([
  { sourceTool: "sessions_send", hidden: true },
  { sourceTool: "subagent_settle", privateCompletion: true as const, hidden: true },
  { sourceTool: "subagent_settle", hidden: false },
])(
  "keeps Codex $sourceTool work in SQLite with its display policy (private=$privateCompletion)",
  async ({ sourceTool, hidden, privateCompletion }) => {
    const base = await createParams();
    const target = {
      agentId: "main",
      sessionId: base.sessionId,
      sessionKey: "agent:main:coordination",
      storePath: path.join(base.workspaceDir, "openclaw-agent.sqlite"),
      bogusSessionFile: path.join(base.workspaceDir, "unused-session.jsonl"),
    };
    await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
    const params: EmbeddedRunAttemptParams = {
      ...base,
      ...target,
      sessionTarget: target,
      prompt: "Review the worker result",
      privateCompletion,
      inputProvenance: { kind: "inter_session", sourceTool, sourceRole: "subagent" },
    };
    const mirror = {
      ...target,
      params,
      notifyUserMessagePersisted: () => undefined,
      cwd: params.workspaceDir,
      threadId: "thread-1",
      turnId: "turn-1",
    };
    const message = (id: string, phase: string, text: string) => ({
      type: "agentMessage",
      id,
      phase,
      text,
    });
    const expectHistory = async (entries: [string, string][]) => {
      const messages = await readCodexMirroredSessionHistoryMessages({
        ...params,
        sessionFile: target.bogusSessionFile,
      });
      expect(messages).toHaveLength(entries.length);
      expect(messages).toMatchObject(
        entries.map(([role, text]) => ({
          role,
          content: role === "user" ? text : [{ type: "text", text }],
        })),
      );
      expect(messages?.map((entry) => Reflect.get(entry, "display") === false)).toEqual(
        entries.map(() => hidden),
      );
    };
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => ({
            message: castAgentMessage({
              ...(event as { message: Record<string, unknown> }).message,
              display: true,
            }),
          }),
        },
      ]),
    );
    await mirrorPromptAtTurnStartBestEffort({ ...mirror, upstreamUserText: params.prompt });
    const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1");
    await projector.handleNotification(
      forCurrentTurn("item/completed", { item: message("progress", "commentary", "progress") }),
    );
    await expectHistory([
      ["user", params.prompt],
      ["assistant", "progress"],
    ]);

    await projector.handleNotification(
      turnCompleted([message("answer", "final_answer", "answer")]),
    );
    await codexTranscriptMirrorRuntime.mirrorBestEffort({
      ...mirror,
      result: projector.buildResult(buildEmptyToolTelemetry()),
    });
    await expectHistory([
      ["user", params.prompt],
      ["assistant", "progress"],
      ["assistant", "answer"],
    ]);
  },
);
