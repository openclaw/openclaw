import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { classifyEmbeddedAgentRunResultForModelFallback } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createContractRunResult,
  openFileBackedSessionManagerForTest,
  OUTCOME_FALLBACK_RUNTIME_CONTRACT,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { createCodexTestModel } from "./test-support.js";

const THREAD_ID = "thread-outcome-contract";
const TURN_ID = "turn-outcome-contract";
const tempDirs = new Set<string>();

type ProjectorNotification = Parameters<CodexAppServerEventProjector["handleNotification"]>[0];
type ProjectedAttemptResult = ReturnType<CodexAppServerEventProjector["buildResult"]>;
type CodexAppServerToolTelemetry = Parameters<CodexAppServerEventProjector["buildResult"]>[0];

async function createParams(): Promise<EmbeddedRunAttemptParams> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-outcome-contract-"));
  tempDirs.add(tempDir);
  const sessionFile = path.join(tempDir, "session.jsonl");
  openFileBackedSessionManagerForTest(sessionFile);
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

function classifyProjectedAttemptResult(result: ProjectedAttemptResult) {
  const finalAssistantText = result.assistantTexts.join("\n\n").trim();
  return classifyEmbeddedAgentRunResultForModelFallback({
    provider: "codex",
    model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
    result: createContractRunResult({
      ...result,
      meta: {
        durationMs: 1,
        aborted: readAttemptTerminal(result).aborted,
        agentHarnessResultClassification: result.agentHarnessResultClassification,
        finalAssistantRawText: finalAssistantText || undefined,
        finalAssistantVisibleText: finalAssistantText || undefined,
      },
    }),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const tempDir of tempDirs) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("Outcome/fallback runtime contract - Codex app-server adapter", () => {
  it.each([
    {
      name: "empty",
      classification: "empty",
      expectedCode: "empty_result",
      notification: undefined,
      items: [],
    },
    {
      name: "reasoning-only",
      classification: "reasoning-only",
      expectedCode: "reasoning_only_result",
      notification: forCurrentTurn("item/reasoning/textDelta", {
        itemId: "reasoning-1",
        delta: OUTCOME_FALLBACK_RUNTIME_CONTRACT.reasoningOnlyText,
      }),
      items: [
        {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          content: [OUTCOME_FALLBACK_RUNTIME_CONTRACT.reasoningOnlyText],
        },
      ],
    },
    {
      name: "planning-only",
      classification: "planning-only",
      expectedCode: "planning_only_result",
      notification: forCurrentTurn("item/plan/delta", {
        itemId: "plan-1",
        delta: OUTCOME_FALLBACK_RUNTIME_CONTRACT.planningOnlyText,
      }),
      items: [
        { type: "plan", id: "plan-1", text: OUTCOME_FALLBACK_RUNTIME_CONTRACT.planningOnlyText },
      ],
    },
    {
      name: "structured planning-only",
      classification: "planning-only",
      expectedCode: "planning_only_result",
      notification: forCurrentTurn("turn/plan/updated", {
        plan: [{ step: OUTCOME_FALLBACK_RUNTIME_CONTRACT.planningOnlyText, status: "pending" }],
      }),
      items: [],
    },
  ] as const)(
    "keeps $name terminal turns fallback-ready with adapter-produced classification",
    async ({ notification, items, classification, expectedCode }) => {
      const projector = await createProjector();
      if (notification) {
        await projector.handleNotification(notification);
      }
      await projector.handleNotification(
        forCurrentTurn("turn/completed", {
          turn: { id: TURN_ID, status: "completed", items },
        }),
      );
      const result = projector.buildResult(buildToolTelemetry());

      expect(result.assistantTexts).toStrictEqual([]);
      expect(result.lastAssistant).toBeUndefined();
      expect(readAttemptTerminal(result).promptError).toBeNull();
      if (classification === "planning-only") {
        expect(result.messagesSnapshot.map((message) => message.role)).toStrictEqual(["user"]);
      } else if (classification === "reasoning-only") {
        expect(result.messagesSnapshot.map((message) => message.role)).toStrictEqual([
          "user",
          "assistant",
        ]);
        const reasoningMessage = result.messagesSnapshot[1];
        if (reasoningMessage?.role !== "assistant") {
          throw new Error("expected Codex reasoning mirror assistant message");
        }
        expect(reasoningMessage).toMatchObject({
          __openclaw: { mirrorIdentity: `${TURN_ID}:reasoning` },
          api: "openai-chatgpt-responses",
          provider: "codex",
          model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
          stopReason: "stop",
        });
        expect(reasoningMessage.content).toStrictEqual([
          {
            type: "thinking",
            thinking: OUTCOME_FALLBACK_RUNTIME_CONTRACT.reasoningOnlyText,
          },
        ]);
        expect(reasoningMessage.usage).toStrictEqual({
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        });
        expect(typeof reasoningMessage.timestamp).toBe("number");
        expect(reasoningMessage.timestamp).toBeGreaterThan(0);
      }
      expect(result.agentHarnessResultClassification).toBe(classification);
      const projected = classifyProjectedAttemptResult(result);
      if (!projected || !("reason" in projected)) {
        throw new Error("expected format fallback projection");
      }
      expect(projected.reason).toBe("format");
      expect(projected.code).toBe(expectedCode);
    },
  );

  it("keeps exact NO_REPLY classified as an intentional silent terminal reply", async () => {
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
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(classifyProjectedAttemptResult(result)).toBeNull();
  });

  it("keeps tool side effects classified as non-fallback terminal outcomes", async () => {
    const projector = await createProjector();
    const result = projector.buildResult(
      buildToolTelemetry({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["sent out of band"],
      }),
    );

    expect(result.assistantTexts).toStrictEqual([]);
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["sent out of band"]);
    expect(result.agentHarnessResultClassification).toBeUndefined();
    expect(classifyProjectedAttemptResult(result)).toBeNull();
  });

  it.each([
    { action: "status", replaySafe: true },
    { action: "add", replaySafe: false },
  ])(
    "classifies an empty Codex turn after cron.$action from structured replay safety",
    async ({ action, replaySafe }) => {
      const toolResult: AgentToolResult<unknown> = {
        content: [{ type: "text", text: "cron complete" }],
        details: { ok: true },
      };
      const bridge = createCodexDynamicToolBridge({
        tools: [
          {
            name: "cron",
            description: "Cron",
            parameters: {
              type: "object",
              properties: { action: { type: "string" } },
              required: ["action"],
              additionalProperties: false,
            },
            execute: vi.fn(async () => toolResult),
          } as never,
        ],
        signal: new AbortController().signal,
      });
      const projector = await createProjector();
      const call = {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        callId: `call-cron-${action}`,
        namespace: null,
        tool: "cron",
        arguments: { action },
      };
      projector.recordDynamicToolCall(call);
      const response = await bridge.handleToolCall(call);
      projector.recordDynamicToolResult({
        callId: call.callId,
        tool: call.tool,
        success: response.success,
        terminalType: response.diagnosticTerminalType,
        sideEffectEvidence: response.sideEffectEvidence === true,
        contentItems: response.contentItems,
      });
      await projector.handleNotification(
        forCurrentTurn("turn/completed", {
          turn: { id: TURN_ID, status: "completed", items: [] },
        }),
      );

      const result = projector.buildResult(bridge.telemetry);

      expect(result.replayMetadata).toEqual({
        hadPotentialSideEffects: !replaySafe,
        replaySafe,
      });
      expect(classifyProjectedAttemptResult(result) !== null).toBe(replaySafe);
    },
  );
});
