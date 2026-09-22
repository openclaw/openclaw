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
  { sourceTool: "subagent_announce", hidden: false },
])(
  "keeps Codex $sourceTool work in SQLite with its display policy",
  async ({ sourceTool, hidden }) => {
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
      workspaceDir: path.dirname(target.storePath),
      prompt: "Review the worker result",
      inputProvenance: { kind: "inter_session", sourceTool, sourceRole: "subagent" },
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
    await mirrorPromptAtTurnStartBestEffort({
      params,
      ...target,
      notifyUserMessagePersisted: () => undefined,
      cwd: params.workspaceDir,
      threadId: "thread-1",
      turnId: "turn-1",
      upstreamUserText: params.prompt,
    });
    const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1");
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "progress",
          phase: "commentary",
          text: "Checking the worker result",
        },
      }),
    );
    const checkpointMessages = await readCodexMirroredSessionHistoryMessages({
      ...params,
      sessionFile: target.bogusSessionFile,
    });
    expect(checkpointMessages).toMatchObject([
      { role: "user", content: params.prompt },
      { role: "assistant", content: [{ type: "text", text: "Checking the worker result" }] },
    ]);
    expect(checkpointMessages?.map((message) => Reflect.get(message, "display") === false)).toEqual(
      [hidden, hidden],
    );

    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "answer",
          phase: "final_answer",
          text: "The repair passed validation",
        },
      ]),
    );
    await codexTranscriptMirrorRuntime.mirrorBestEffort({
      params,
      result: projector.buildResult(buildEmptyToolTelemetry()),
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      notifyUserMessagePersisted: () => undefined,
      cwd: params.workspaceDir,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const messages = await readCodexMirroredSessionHistoryMessages({
      ...params,
      sessionFile: target.bogusSessionFile,
    });
    expect(messages).toHaveLength(3);
    expect(messages?.map((message) => Reflect.get(message, "display") === false)).toEqual([
      hidden,
      hidden,
      hidden,
    ]);
    expect(messages?.[2]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "The repair passed validation" }],
    });
  },
);
