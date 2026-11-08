// Codex tests cover delivery no reply runtime contract plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  DELIVERY_NO_REPLY_RUNTIME_CONTRACT,
  openFileBackedSessionManagerForTest,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { prepareCodexServerNotification } from "./protocol-validators.js";
import type { CodexServerNotification } from "./protocol.js";
import { createCodexTestModel } from "./test-support.js";

const THREAD_ID = "thread-delivery-contract";
const TURN_ID = "turn-delivery-contract";
const tempDirs = new Set<string>();

type ProjectorNotification = Parameters<CodexAppServerEventProjector["handleNotification"]>[0];

async function createParams(): Promise<EmbeddedRunAttemptParams> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-delivery-contract-"));
  tempDirs.add(tempDir);
  const sessionFile = path.join(tempDir, "session.jsonl");
  openFileBackedSessionManagerForTest(sessionFile);
  return {
    prompt: DELIVERY_NO_REPLY_RUNTIME_CONTRACT.prompt,
    sessionId: DELIVERY_NO_REPLY_RUNTIME_CONTRACT.sessionId,
    sessionKey: DELIVERY_NO_REPLY_RUNTIME_CONTRACT.sessionKey,
    sessionFile,
    workspaceDir: tempDir,
    runId: DELIVERY_NO_REPLY_RUNTIME_CONTRACT.runId,
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
  } as EmbeddedRunAttemptParams;
}

function forCurrentTurn(
  method: ProjectorNotification["method"],
  params: Record<string, unknown>,
): ProjectorNotification {
  return prepareCodexServerNotification({
    method,
    params: { threadId: THREAD_ID, turnId: TURN_ID, ...params },
  } as CodexServerNotification);
}

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("Delivery/NO_REPLY runtime contract - Codex app-server adapter", () => {
  it.each([
    { text: `  ${DELIVERY_NO_REPLY_RUNTIME_CONTRACT.silentText}  `, disposition: "silent" },
    { text: DELIVERY_NO_REPLY_RUNTIME_CONTRACT.jsonSilentText, disposition: "visible" },
  ])("prepares $disposition terminal text at the producer", async ({ text, disposition }) => {
    const projector = new CodexAppServerEventProjector(await createParams(), THREAD_ID, TURN_ID);
    await projector.handleNotification(
      forCurrentTurn("item/agentMessage/delta", {
        itemId: "msg-1",
        delta: text,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "agentMessage", id: "msg-1", phase: "final_answer", text },
      }),
    );

    const result = projector.buildResult({
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      toolMediaUrls: [],
      toolAudioAsVoice: false,
    });

    expect(result.assistantTexts).toEqual(disposition === "silent" ? [] : [text]);
    expect(result.preparedTerminalReply).toEqual({
      text: disposition === "silent" ? "" : text,
      terminalReply: disposition === "silent" ? { disposition } : { disposition, text },
    });
  });
});
