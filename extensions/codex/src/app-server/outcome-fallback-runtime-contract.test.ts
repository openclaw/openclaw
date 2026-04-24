import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { afterEach, describe, expect, it } from "vitest";
import { OUTCOME_FALLBACK_RUNTIME_CONTRACT } from "../../../../test/helpers/agents/outcome-fallback-runtime-contract.js";
import {
  CodexAppServerEventProjector,
  type CodexAppServerToolTelemetry,
} from "./event-projector.js";
import { createCodexTestModel } from "./test-support.js";

const THREAD_ID = "thread-outcome-contract";
const TURN_ID = "turn-outcome-contract";
const tempDirs = new Set<string>();

type ProjectorNotification = Parameters<CodexAppServerEventProjector["handleNotification"]>[0];

async function createParams(): Promise<EmbeddedRunAttemptParams> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-outcome-contract-"));
  tempDirs.add(tempDir);
  const sessionFile = path.join(tempDir, "session.jsonl");
  SessionManager.open(sessionFile);
  return {
    prompt: OUTCOME_FALLBACK_RUNTIME_CONTRACT.prompt,
    sessionId: OUTCOME_FALLBACK_RUNTIME_CONTRACT.sessionId,
    sessionKey: OUTCOME_FALLBACK_RUNTIME_CONTRACT.sessionKey,
    sessionFile,
    workspaceDir: tempDir,
    runId: OUTCOME_FALLBACK_RUNTIME_CONTRACT.runId,
    provider: "codex",
    modelId: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
  } as EmbeddedRunAttemptParams;
}

async function createProjector(): Promise<CodexAppServerEventProjector> {
  return new CodexAppServerEventProjector(await createParams(), THREAD_ID, TURN_ID);
}

function buildToolTelemetry(
  overrides: Partial<CodexAppServerToolTelemetry> = {},
): CodexAppServerToolTelemetry {
  return {
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    toolMediaUrls: [],
    toolAudioAsVoice: false,
    ...overrides,
  };
}

function forCurrentTurn(
  method: ProjectorNotification["method"],
  params: Record<string, unknown>,
): ProjectorNotification {
  return {
    method,
    params: { threadId: THREAD_ID, turnId: TURN_ID, ...params },
  } as ProjectorNotification;
}

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("Outcome/fallback runtime contract - Codex app-server adapter", () => {
  it("preserves an empty terminal turn for OpenClaw-owned fallback classification", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: { id: TURN_ID, status: "completed", items: [] },
      }),
    );

    const result = projector.buildResult(buildToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.promptError).toBeNull();
  });

  it("preserves exact NO_REPLY as assistant text instead of classifying in the adapter", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("item/agentMessage/delta", {
        itemId: "msg-1",
        delta: "NO_REPLY",
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "NO_REPLY" }],
        },
      }),
    );

    const result = projector.buildResult(buildToolTelemetry());

    expect(result.assistantTexts).toEqual(["NO_REPLY"]);
    expect(result.lastAssistant?.content).toEqual([{ type: "text", text: "NO_REPLY" }]);
    expect(result.promptError).toBeNull();
  });

  it("preserves tool side-effect telemetry so fallback can stay disabled", async () => {
    const projector = await createProjector();

    const result = projector.buildResult(
      buildToolTelemetry({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["sent out of band"],
      }),
    );

    expect(result.assistantTexts).toEqual([]);
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["sent out of band"]);
  });
});
