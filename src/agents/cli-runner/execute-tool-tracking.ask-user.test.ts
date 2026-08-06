import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  updateMcpLoopbackToolCallCapture,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { createAskUserTool } from "../tools/ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "../tools/ask-user-tool.test-support.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

const args = {
  questions: [
    {
      id: "deploy_target",
      header: "Target",
      question: "Where should this deploy?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
};

type GatewayCall = NonNullable<Parameters<typeof createAskUserTool>[0]["gatewayCall"]>;

function buildContext(params: {
  runId: string;
  sessionKey: string;
  onAskUserPrompt: NonNullable<PreparedCliRunContext["params"]["onAskUserPrompt"]>;
}): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: [],
    output: "jsonl" as const,
    input: "stdin" as const,
    serialize: true,
  };
  return {
    params: {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: params.sessionKey,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "ask",
      provider: "claude-cli",
      model: "claude-sonnet-4-5",
      timeoutMs: 60_000,
      runId: params.runId,
      onAskUserPrompt: params.onAskUserPrompt,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: { id: "claude-cli", config: backend, bundleMcp: true },
    preparedBackend: { backend, env: {} },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "claude-sonnet-4-5",
    normalizedModel: "claude-sonnet-4-5",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 1,
  } as PreparedCliRunContext;
}

function prepareCapturedAskUser(params: {
  context: PreparedCliRunContext;
  captureKey: string;
  toolCallId: string;
  toolArgs?: typeof args;
}) {
  const tracking = createCliToolTracking(params.context);
  tracking.beginGatewayCapture(params.captureKey);
  const callArgs = params.toolArgs ?? args;
  const captureHandle = markMcpLoopbackToolCallStarted({
    captureKey: params.captureKey,
    toolName: "ask_user",
    args: callArgs,
  });
  if (!captureHandle) {
    throw new Error("expected ask_user capture");
  }
  updateMcpLoopbackToolCallCapture(captureHandle, {
    toolCallId: params.toolCallId,
    toolName: "ask_user",
    args: callArgs,
  });
  return { captureHandle, tracking };
}

function createGatewayStub() {
  let finishWait: ((value: unknown) => void) | undefined;
  const mock = vi.fn(async (method: string, _opts: unknown, params: Record<string, unknown>) => {
    if (method === "question.request") {
      return { id: params.id };
    }
    if (method === "question.waitAnswer") {
      return await new Promise((resolve) => {
        finishWait = resolve;
      });
    }
    if (method === "question.resolve") {
      finishWait?.({ status: "cancelled" });
      return { status: "cancelled" };
    }
    throw new Error(`unexpected method ${method}`);
  });
  return {
    call: mock as unknown as GatewayCall,
    answer: (value: string) =>
      finishWait?.({
        status: "answered",
        answers: { answers: { deploy_target: [value] } },
      }),
  };
}

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
});

describe("CLI loopback ask_user presentation", () => {
  it("presents and answers the exact prepared MCP tool call", async () => {
    const runId = "run-cli-ask-answer";
    const sessionKey = "agent:main:cli-ask-answer";
    const gateway = createGatewayStub();
    const onAskUserPrompt = vi.fn(async () => {
      gateway.answer("Production");
    });
    const context = buildContext({ runId, sessionKey, onAskUserPrompt });
    const { captureHandle, tracking } = prepareCapturedAskUser({
      context,
      captureKey: "capture-cli-ask-answer",
      toolCallId: "mcp-cli-ask-answer",
    });

    try {
      const result = await createAskUserTool({
        sessionKey,
        runId,
        gatewayCall: gateway.call,
      }).execute("mcp-cli-ask-answer", args);

      expect(onAskUserPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          channelData: { askUser: { questionId: expect.stringMatching(/^ask_/) } },
        }),
      );
      expect(result).toMatchObject({
        details: {
          status: "answered",
          answers: { answers: { deploy_target: ["Production"] } },
        },
      });
    } finally {
      markMcpLoopbackToolCallFinished(captureHandle);
      tracking.finalizeCapture(() => {});
    }
  });

  it("propagates prompt delivery errors and releases the session slot", async () => {
    const runId = "run-cli-ask-error";
    const sessionKey = "agent:main:cli-ask-error";
    const gateway = createGatewayStub();
    const context = buildContext({
      runId,
      sessionKey,
      onAskUserPrompt: async () => {
        throw new Error("channel unavailable");
      },
    });
    const { captureHandle, tracking } = prepareCapturedAskUser({
      context,
      captureKey: "capture-cli-ask-error",
      toolCallId: "mcp-cli-ask-error",
    });

    try {
      await expect(
        createAskUserTool({ sessionKey, runId, gatewayCall: gateway.call }).execute(
          "mcp-cli-ask-error",
          args,
        ),
      ).rejects.toThrow("ask_user prompt delivery failed");
    } finally {
      markMcpLoopbackToolCallFinished(captureHandle);
      tracking.finalizeCapture(() => {});
    }

    const retry = prepareCapturedAskUser({
      context,
      captureKey: "capture-cli-ask-retry",
      toolCallId: "mcp-cli-ask-retry",
    });
    markMcpLoopbackToolCallFinished(retry.captureHandle);
    retry.tracking.finalizeCapture(() => {});
  });

  it("keeps concurrent prepared calls to one visible prompt per session", async () => {
    const runId = "run-cli-ask-concurrent";
    const sessionKey = "agent:main:cli-ask-concurrent";
    const gateway = createGatewayStub();
    const onAskUserPrompt = vi.fn(async () => {
      gateway.answer("Staging");
    });
    const context = buildContext({ runId, sessionKey, onAskUserPrompt });
    const first = prepareCapturedAskUser({
      context,
      captureKey: "capture-cli-ask-first",
      toolCallId: "mcp-cli-ask-first",
    });
    const second = prepareCapturedAskUser({
      context,
      captureKey: "capture-cli-ask-second",
      toolCallId: "mcp-cli-ask-second",
    });

    try {
      await createAskUserTool({ sessionKey, runId, gatewayCall: gateway.call }).execute(
        "mcp-cli-ask-first",
        args,
      );
      expect(onAskUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      markMcpLoopbackToolCallFinished(first.captureHandle);
      first.tracking.finalizeCapture(() => {});
      markMcpLoopbackToolCallFinished(second.captureHandle);
      second.tracking.finalizeCapture(() => {});
    }
  });
});
