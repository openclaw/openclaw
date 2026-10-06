import type { AgentEvent } from "openclaw/plugin-sdk/agent-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  onAgentEvent as registerAgentEventListener,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import {
  buildBlockedToolResult,
  recordAdjustedParamsForToolCall,
  recordStructuredReplayTrustForToolCall,
} from "./agent-tools.before-tool-call.js";
import {
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
  recordToolExecutionTracked,
} from "./agent-tools.before-tool-call.state.js";
import { addSession, deleteSession, markExited } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";
import { projectEmbeddedMessageDeliveryFact } from "./embedded-agent-message-delivery.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import {
  handleToolExecutionStart,
  handleToolExecutionUpdate,
} from "./embedded-agent-subscribe.handlers.tools.js";
import { registerToolChannelProgressTests } from "./embedded-agent-subscribe.handlers.tools.progress.test-support.js";
import {
  createTestContext,
  endTool,
  resultWithDetails,
  type ToolExecutionEndEvent,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import { claimPendingAgentQuestionAnswer } from "./harness/gateway-question.js";
import {
  createAskUserTool,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
} from "./tools/ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./tools/ask-user-tool.test-support.js";
import { createSecretsTool } from "./tools/secrets-tool.js";
import { markCoreTtsToolResult } from "./tools/tts-tool-result-provenance.js";

type ToolExecutionStartEvent = Omit<Extract<AgentEvent, { type: "tool_execution_start" }>, "type">;
type ToolExecutionUpdateEvent = {
  toolName: string;
  toolCallId: string;
  args?: unknown;
  partialResult?: unknown;
  hideFromChannelProgress?: boolean;
};

function startTool(ctx: ToolHandlerContext, event: ToolExecutionStartEvent) {
  return handleToolExecutionStart(ctx, { type: "tool_execution_start", ...event });
}

async function executeTool(
  ctx: ToolHandlerContext,
  event: ToolExecutionStartEvent & Omit<ToolExecutionEndEvent, "toolName" | "toolCallId">,
) {
  const { toolName, toolCallId, args, ...completion } = event;
  await startTool(ctx, { toolName, toolCallId, args });
  await endTool(ctx, { toolName, toolCallId, ...completion });
}

function updateTool(ctx: ToolHandlerContext, event: ToolExecutionUpdateEvent) {
  return handleToolExecutionUpdate(ctx, {
    type: "tool_execution_update",
    args: event.args ?? {},
    partialResult: event.partialResult,
    ...event,
  });
}

const pendingAskUserFinishes = new Set<() => Promise<void>>();

function createBasicAskUserArgs() {
  return {
    questions: [
      {
        id: "target",
        header: "Target",
        question: "Where next?",
        options: [{ label: "Staging" }, { label: "Production" }],
      },
    ],
  };
}

async function activateAskUserPrompt(toolCallId: string, args: unknown) {
  let questionId: string | undefined;
  let resolveAnswer: ((value: { status: "cancelled" }) => void) | undefined;
  const tool = createAskUserTool({
    sessionKey: "agent:unit-session",
    runId: "run-test",
    gatewayCall: async (method, _opts, params) => {
      if (method === "question.request") {
        if (!params || typeof params !== "object" || !("id" in params)) {
          throw new Error("question.request params missing id");
        }
        questionId = String(params.id);
        return { id: questionId };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          resolveAnswer = resolve;
        });
      }
      throw new Error(`unexpected method ${method}`);
    },
  });
  const pending = tool.execute(toolCallId, args);
  let finished = false;
  const finish = async () => {
    if (finished) {
      return;
    }
    finished = true;
    await vi.waitFor(() => expect(resolveAnswer).toBeTypeOf("function"));
    resolveAnswer?.({ status: "cancelled" });
    await pending;
    pendingAskUserFinishes.delete(finish);
  };
  pendingAskUserFinishes.add(finish);
  await vi.waitFor(() => expect(questionId).toBeTypeOf("string"));
  return { questionId: questionId!, finish };
}

afterEach(async () => {
  await Promise.all([...pendingAskUserFinishes].map((finish) => finish()));
  resetPendingAskUserQuestionsForTest();
});

const beforeToolCallTesting = { adjustedParamsByToolCallId, buildAdjustedParamsKey };

type CapturedAgentEvent = { stream?: string; data?: Record<string, unknown> };

function captureAgentEvents(): CapturedAgentEvent[] {
  const events: CapturedAgentEvent[] = [];
  registerAgentEventListener((event) => events.push(event));
  return events;
}

function requireEvent(
  events: CapturedAgentEvent[],
  predicate: (event: CapturedAgentEvent) => boolean,
  label: string,
): CapturedAgentEvent {
  const event = events.find(predicate);
  if (!event) {
    throw new Error(`expected ${label} event`);
  }
  return event;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`expected ${label}`);
  }
  return value;
}

describe("progress_card compatibility plan events", () => {
  it("emits the typed full plan snapshot after a successful write", async () => {
    const { ctx, onAgentEvent } = createTestContext();
    ctx.params.onToolResult = vi.fn();
    ctx.shouldEmitToolResult = () => true;
    ctx.shouldEmitToolOutput = () => true;
    const emitted: CapturedAgentEvent[] = [];
    const unsubscribe = registerAgentEventListener((event) => emitted.push(event));
    try {
      await executeTool(ctx, {
        toolName: "progress_card",
        toolCallId: "plan-1",
        args: {
          markdown: "Implementation underway",
          plan: [
            { step: "Inspect", status: "completed" },
            { step: "Patch", status: "in_progress" },
          ],
        },
        result: {
          content: [{ type: "text", text: "Progress card updated (rev 2, 1/2 done)" }],
          details: { revision: 2, steps: { completed: 1, total: 2 } },
        },
      });
      await Promise.resolve();

      const expected = {
        stream: "plan",
        data: {
          phase: "update",
          title: "Plan updated",
          source: "openclaw",
          explanation: "1/2 complete",
          steps: [
            { step: "Inspect", status: "completed" },
            { step: "Patch", status: "in_progress" },
          ],
        },
      };
      expect(onAgentEvent).toHaveBeenCalledWith(expected);
      expect(emitted).toContainEqual(expect.objectContaining(expected));
      expect(ctx.emitToolSummary).not.toHaveBeenCalled();
      expect(ctx.emitToolOutput).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

const requireRecord = createRequireRecord("record", "expected-label-object");

function expectRecordFields(value: unknown, label: string, expected: Record<string, unknown>) {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function requireMockCallArg(mock: ReturnType<typeof vi.fn>, callIndex: number, label: string) {
  return requireRecord(mock.mock.calls[callIndex]?.[0], label);
}

function requireNestedRecord(value: unknown, label: string, path: string[]) {
  let current = value;
  for (const key of path) {
    current = requireRecord(current, label)[key];
  }
  return requireRecord(current, label);
}

function expectInteractiveApprovalButtons(
  result: Record<string, unknown>,
  expectedButtons: readonly Record<string, unknown>[],
) {
  const interactive = result.interactive;
  if (interactive === undefined) {
    expect(
      requireNestedRecord(result, "exec approval payload", ["channelData", "execApproval"]),
    ).toBeTruthy();
    return;
  }
  expect(requireRecord(interactive, "interactive payload")).toEqual({
    blocks: [{ type: "buttons", buttons: expectedButtons }],
  });
}

function requireSingleMessagingTarget(ctx: ToolHandlerContext) {
  const targets = ctx.state.messagingToolSentTargets;
  expect(targets).toHaveLength(1);
  return requireRecord(targets[0], "messaging target");
}

describe("handleToolExecutionStart read path checks", () => {
  it("reserves the question before flushing and delivers only its numbered prompt", async () => {
    const { ctx, onBlockReplyFlush } = createTestContext();
    const flush = createDeferred();
    onBlockReplyFlush.mockReturnValue(flush.promise);
    const delivered = createDeferred();
    const onToolResult = vi.fn(() => delivered.resolve());
    ctx.params.onToolResult = onToolResult;
    const args = {
      questions: [
        {
          id: "deploy_target",
          header: "Target",
          question: "Where should this deploy?",
          options: [
            { label: "Staging (Recommended)", description: "Safer default" },
            { label: "Production" },
          ],
        },
      ],
    };

    const pending = startTool(ctx, {
      toolName: "ask_user",
      toolCallId: "ask-call-1",
      args,
    });
    const activation = await activateAskUserPrompt("ask-call-1", args);
    expect(onToolResult).not.toHaveBeenCalled();
    flush.resolve();
    await pending;
    await delivered.promise;
    expect(onToolResult).toHaveBeenCalledOnce();
    await startTool(ctx, { toolName: "ask_user", toolCallId: "ask-second", args });
    expect(onToolResult).toHaveBeenCalledOnce();
    const { questionId } = activation;

    expect(onToolResult).toHaveBeenCalledWith({
      text: [
        "Question for you:",
        "",
        "Target",
        "Where should this deploy?",
        "1. Staging (Recommended) - Safer default",
        "2. Production",
        "Other: reply with your own answer.",
        "",
        "Reply with the number, the option text, or your own answer.",
      ].join("\n"),
      channelData: {
        askUser: {
          questionId,
          optionValues: ["Staging (Recommended)", "Production"],
        },
      },
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          { type: "text", text: "Where should this deploy?" },
          {
            type: "text",
            text: [
              "- Staging (Recommended): Safer default",
              "- Production",
              "",
              "Reply with the number, the option text, or your own answer.",
            ].join("\n"),
          },
          {
            type: "buttons",
            buttons: [
              {
                label: "Staging (Recommended)",
                action: {
                  type: "question",
                  questionId,
                  optionValue: "Staging (Recommended)",
                },
              },
              {
                label: "Production",
                action: {
                  type: "question",
                  questionId,
                  optionValue: "Production",
                },
              },
              {
                label: "Other…",
                action: {
                  type: "question",
                  questionId,
                  intent: "custom-input",
                },
              },
            ],
          },
        ],
      },
    });
    await activation.finish();
  });

  it.each([
    {
      name: "public Control UI",
      messageChannel: "telegram",
      publicOrigin: "https://console.example.test",
      enabled: true,
      available: true,
    },
    {
      name: "missing public origin",
      messageChannel: "discord",
      publicOrigin: undefined,
      enabled: true,
      available: false,
    },
    {
      name: "disabled Control UI",
      messageChannel: "telegram",
      publicOrigin: "https://console.example.test",
      enabled: false,
      available: false,
    },
    {
      name: "native app with disabled Control UI",
      messageChannel: "webchat",
      publicOrigin: undefined,
      enabled: false,
      available: true,
    },
  ])(
    "delivers a credential link or native prompt or visible blocker for $name",
    async ({ messageChannel, publicOrigin, enabled, available }) => {
      vi.useFakeTimers();
      const { ctx } = createTestContext();
      const delivered = createDeferred();
      const answer = createDeferred<unknown>();
      const onToolResult = vi.fn<NonNullable<ToolHandlerContext["params"]["onToolResult"]>>(
        async () => delivered.promise,
      );
      ctx.params.onToolResult = onToolResult;
      ctx.params.messageChannel = messageChannel;
      // A destination id must not be mistaken for the channel family.
      ctx.params.currentChannelId = "telegram";
      ctx.params.config = {
        gateway: { publicOrigin, controlUi: { basePath: "/control", enabled } },
      };
      const args = { action: "request", name: "TEST_API_KEY", kind: "secret" };
      let questionId = "";
      const gatewayCall = vi.fn(async (method: string, _options: unknown, params: unknown) => {
        if (method === "question.request") {
          questionId = String(requireRecord(params, "question request").id);
          return { id: questionId };
        }
        if (method === "question.waitAnswer") {
          return await answer.promise;
        }
        if (method === "question.resolve") {
          answer.resolve({ status: "cancelled" });
          return { ok: true };
        }
        throw new Error(`unexpected method ${method}`);
      });
      const tool = createSecretsTool({
        agentId: ctx.params.agentId,
        sessionKey: ctx.params.sessionKey,
        runId: ctx.params.runId,
        gatewayCall,
      });

      await startTool(ctx, { toolName: "secrets", toolCallId: "secret-call-1", args });
      // Attach rejection handling before any assertion, and always retire both waits.
      const outcome = tool.execute("secret-call-1", args).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        await vi.advanceTimersByTimeAsync(50);
        expect(gatewayCall.mock.calls.some(([method]) => method === "question.waitAnswer")).toBe(
          true,
        );
        expect(gatewayCall.mock.calls.some(([method]) => method === "question.resolve")).toBe(
          false,
        );
        await expect(
          claimPendingAgentQuestionAnswer({
            sessionKey: ctx.params.sessionKey!,
            text: "not-a-credential",
          }),
        ).resolves.toBe(false);
        if (messageChannel === "webchat") {
          expect(onToolResult).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());
          const payload = onToolResult.mock.calls[0]?.[0];
          if (available) {
            expect(payload?.text).toBe(
              `🔑 Agent requests credential TEST_API_KEY (secret). Reply is disabled for secrets — open to provide it: https://console.example.test/control/ask/${questionId}`,
            );
          } else {
            expect(payload?.text).toContain("Credential request unavailable here");
            expect(payload?.text).toContain("Control UI or native app");
            expect(payload?.text).toContain("retry");
            expect(payload?.text).toContain("Never send credentials in chat");
            expect(payload?.text).not.toMatch(/https?:/);
          }
          expect(payload?.channelData).toEqual({ askUser: { questionId } });
          expect(payload).not.toHaveProperty("presentation");
          expect(payload).not.toHaveProperty("interactive");
          expect(payload?.text).not.toContain("Reply with your answer");
        }
        // A blocker must finish delivery while its question is still pending.
        expect(gatewayCall.mock.calls.some(([method]) => method === "question.resolve")).toBe(
          false,
        );
        delivered.resolve();
        if (available) {
          answer.resolve({
            status: "answered",
            answers: { answers: { secret_value: ["stored"] } },
          });
          await expect(outcome).resolves.toMatchObject({
            result: { details: { status: "stored" } },
          });
          expect(gatewayCall.mock.calls.some(([method]) => method === "question.resolve")).toBe(
            false,
          );
        } else {
          await expect(outcome).resolves.toMatchObject({
            error: new Error("credential-request prompt delivery failed"),
          });
          expect(gatewayCall).toHaveBeenCalledWith(
            "question.resolve",
            { timeoutMs: 10_000 },
            {
              id: questionId,
              cancel: true,
              resolvedBy: "prompt-delivery-failed",
            },
          );
        }
      } finally {
        delivered.resolve();
        answer.resolve({ status: "cancelled" });
        await outcome;
        vi.useRealTimers();
      }
    },
  );

  it.each([
    {
      name: "multi-question",
      questions: [
        ...createBasicAskUserArgs().questions,
        {
          id: "region",
          header: "Region",
          question: "Which region?",
          options: [{ label: "EU" }, { label: "US" }],
        },
      ],
      hint: "Reply by number or question id. Use a declared option where choices are fixed.",
    },
    {
      name: "multi-select",
      questions: [
        {
          id: "checks",
          header: "Checks",
          question: "Which checks should run?",
          options: [{ label: "Unit" }, { label: "Lint" }],
          multiSelect: true,
        },
      ],
      hint: "Reply with comma-separated option numbers or text, or your own answer.",
    },
  ])("keeps $name ask_user prompts text-only", async ({ name, questions, hint }) => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    const toolCallId = `ask-${name}`;

    await startTool(ctx, {
      toolName: "ask_user",
      toolCallId,
      args: { questions },
    });
    const activation = await activateAskUserPrompt(toolCallId, { questions });
    await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());

    const payload = onToolResult.mock.calls[0]?.[0];
    expect(payload?.text).toContain(hint);
    expect(payload).not.toHaveProperty("presentation");
    expect(payload).not.toHaveProperty("presentationTextMode");
    expect(payload?.channelData).toEqual({ askUser: { questionId: activation.questionId } });
    await activation.finish();
  });

  it.each(["callback"] as const)(
    "releases ask_user reservation when the %s flush throws synchronously",
    (flushKind) => {
      const { ctx, onBlockReplyFlush } = createTestContext();
      ctx.params.onToolResult = vi.fn();
      const failure = new Error("flush failed");
      onBlockReplyFlush.mockImplementation(() => {
        throw failure;
      });
      const args = createBasicAskUserArgs();

      expect(() =>
        startTool(ctx, {
          toolName: "ask_user",
          toolCallId: `ask-${flushKind}-failure`,
          args,
        }),
      ).toThrow(failure);
      expect(
        reserveAskUserPromptDelivery({
          toolCallId: `ask-${flushKind}-retry`,
          sessionKey: "agent:unit-session",
          questions: normalizeAskUserParams(args).questions,
        }),
      ).toBeDefined();
    },
  );

  it("releases an undelivered ask_user reservation when execution is rejected", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    const args = createBasicAskUserArgs();

    await executeTool(ctx, {
      toolName: "ask_user",
      toolCallId: "ask-denied",
      args,
      isError: true,
      result: { content: [{ type: "text", text: "denied" }] },
    });
    await Promise.resolve();
    expect(onToolResult).not.toHaveBeenCalled();

    await startTool(ctx, {
      toolName: "ask_user",
      toolCallId: "ask-after-denial",
      args,
    });
    const activation = await activateAskUserPrompt("ask-after-denial", args);
    await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());
    await activation.finish();
  });

  it("warns for a missing read path and accepts the corrected file_path alias", async () => {
    const { ctx, warn, trace, isEnabled, onBlockReplyFlush, onExecutionPhase } =
      createTestContext();
    isEnabled.mockImplementation((level: string) => level === "trace");

    const evt: ToolExecutionStartEvent = {
      toolName: "read",
      toolCallId: "tool-2",
      args: {},
    };

    await startTool(ctx, evt);

    expect(warn).toHaveBeenCalledTimes(1);
    const warnMessage = String(warn.mock.calls[0]?.[0] ?? "");
    const warnMeta = warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(warnMessage).toContain("read tool called without path");
    expect(warnMeta).toBeTypeOf("object");
    expect(warnMeta?.event).toBe("embedded_read_tool_start_warning");
    expect(warnMeta?.tags).toEqual(["tool_start", "read", "embedded", "validation"]);
    expect(warnMeta?.runId).toBe("run-test");
    expect(warnMeta?.sessionKey).toBe("agent:unit-session");
    expect(warnMeta?.sessionId).toBe("session-test-id");
    expect(warnMeta?.agentId).toBe("agent-test-id");
    expect(warnMeta?.toolCallId).toBe("tool-2");
    expect(warnMeta?.argsType).toBe("object");
    expect(warnMeta?.consoleMessage).toContain("runId=run-test");
    expect(warnMeta?.consoleMessage).toContain("sessionKey=agent:unit-session");
    expect(warnMeta?.consoleMessage).toContain("sessionId=session-test-id");
    expect(warnMeta?.consoleMessage).toContain("agentId=agent-test-id");
    expect(warnMeta?.consoleMessage).toContain("toolCallId=tool-2");
    expect(warnMeta?.consoleMessage).toContain("argsType=object");
    expect(warnMeta?.consoleMessage).toContain("read tool called without path");
    expect(warnMeta).not.toHaveProperty("argsPreview");
    await startTool(ctx, {
      toolName: "read",
      toolCallId: "tool-read-corrected",
      args: { file_path: "/tmp/example.txt" },
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(trace).toHaveBeenCalledTimes(2);
    expect(trace.mock.calls[1]?.[1]).not.toHaveProperty("requiredParamsMissing");
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(2);
    expect(onBlockReplyFlush).toHaveBeenCalledWith({
      reason: "tool_start",
      assistantMessageIndex: 0,
    });
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "tool_execution_started",
      tool: "read",
      toolCallId: "tool-read-corrected",
      source: "embedded-agent",
    });
  });

  it.each([
    ["marks astral-only previews as truncated", "😀".repeat(101), `${"😀".repeat(100)}…`],
    ["does not scan beyond the raw warning bound", `${" ".repeat(200)}hidden`, undefined],
  ])("read warning %s", async (_name, args, expected) => {
    const { ctx, warn } = createTestContext();
    await startTool(ctx, { toolName: "read", toolCallId: "tool-bounded-args", args });

    const warnMeta = warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    if (expected === undefined) {
      expect(warnMeta).not.toHaveProperty("argsPreview");
    } else {
      const argsPreview = warnMeta?.argsPreview;
      expect(typeof argsPreview).toBe("string");
      expect(argsPreview).toBe(expected);
      expect(argsPreview).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    }
  });

  it("keeps tool state when phase callbacks throw and event callbacks reject", async () => {
    const { ctx, warn, onExecutionPhase, onAgentEvent } = createTestContext();
    onExecutionPhase.mockImplementation(() => {
      throw new Error("phase exploded");
    });
    onAgentEvent.mockRejectedValue(new Error("event exploded"));

    const evt: ToolExecutionStartEvent = {
      toolName: "exec",
      toolCallId: "tool-callback-throws",
      args: { command: "echo hi" },
    };

    await startTool(ctx, evt);
    await Promise.resolve();

    expect(ctx.state.toolMetaById.has("tool-callback-throws")).toBe(true);
    expect(ctx.state.itemStartedCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("tool execution phase callback failed"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tool agent event callback failed"));
  });

  it.each([true, false, undefined])(
    "keeps wait telemetry with progress privacy %s",
    async (hidden) => {
      const { ctx, onAgentEvent } = createTestContext();
      const progressPrivacy = hidden === undefined ? {} : { hideFromChannelProgress: hidden };

      await startTool(ctx, {
        toolName: "wait",
        toolCallId: "tool-code-wait",
        args: { runId: "cm_1" },
        ...progressPrivacy,
      });
      updateTool(ctx, {
        toolName: "wait",
        toolCallId: "tool-code-wait",
        args: { runId: "cm_1" },
        partialResult: { status: "waiting" },
        ...progressPrivacy,
      });
      await endTool(ctx, {
        toolName: "wait",
        toolCallId: "tool-code-wait",
        result: { details: { status: "completed" } },
        ...progressPrivacy,
      });

      const lifecycleEvents = onAgentEvent.mock.calls
        .map((call) => call[0] as CapturedAgentEvent)
        .filter((event) => event.data?.name === "wait");
      expect(lifecycleEvents).not.toHaveLength(0);
      expect(
        lifecycleEvents.every(
          (event) => (event.data?.hideFromChannelProgress === true) === (hidden === true),
        ),
      ).toBe(true);
    },
  );
});

describe("handleToolExecutionEnd cron mutation tracking", () => {
  it.each([
    ...(
      [
        ["exec", "pnpm exec openclaw cron add --at +1h --message 'follow up'"],
        ["exec", "npx -y openclaw cron add --at +1h --message 'follow up'"],
        ["exec", "bunx --bun openclaw cron add --at +1h --message 'follow up'"],
        ["exec", "pnpm dlx openclaw@latest cron add --at +1h --message 'follow up'"],
        ["exec", "npx openclaw@latest cron add --at +1h --message 'follow up'"],
        ["exec", "/usr/local/bin/openclaw cron add --at +1h --message 'follow up'"],
        ["bash", "corepack pnpm exec openclaw cron add --at +1h --message 'follow up'"],
        ["exec", "env OPENCLAW_PROFILE=test openclaw cron add --at +1h --message 'follow up'"],
        ["exec", "openclaw --profile work cron create --at +1h --message 'follow up'"],
        ["exec", "openclaw --dev cron add --at +1h --message 'follow up'"],
        ["exec", "openclaw --log-level debug --no-color cron add --at +1h --message 'follow up'"],
        ["exec", "openclaw --container helper cron add --at +1h --message 'follow up'"],
        ["exec", "openclaw cron add --at +1h --message 'follow up || wait'"],
        ["exec", "openclaw cron add --at +1h --message 'follow up' 2>&1"],
      ] as const
    ).map(([toolName, command]) => ({ toolName, command, expected: 1 })),
    ...(
      [
        ["openclaw cron list --json", "a different cron action"],
        ["echo openclaw cron add --at +1h", "a command that only mentions cron add"],
        ["openclaw cron add --at '+1h", "an unterminated shell argument"],
        ["cd /tmp && openclaw cron add --at +1h", "a compound command"],
        ["openclaw cron add --help", "the add command help"],
        ["openclaw cron create -h", "the create alias help"],
        ["openclaw cron add --at +1h; true", "a semicolon suffix"],
        ["openclaw cron add --at +1h | cat", "a pipeline suffix"],
        ["openclaw cron add --at +1h\ntrue", "a newline-separated suffix"],
        ["openclaw cron add --bad # ignored\ntrue", "a comment-masked cron failure"],
        ["npx -y echo openclaw cron add --at +1h", "a package runner for another executable"],
        ["pnpm openclaw cron add --at +1h", "a bare pnpm package script"],
        ["corepack pnpm openclaw cron add --at +1h", "a corepack pnpm package script"],
        ["openclaw@latest cron add --at +1h", "a package spec without a package runner"],
        ["pnpm exec openclaw@latest cron add --at +1h", "a package spec passed to pnpm exec"],
        ["openclaw cron add --bad &>/tmp/cron.log", "a bash-only combined redirection"],
        ["openclaw cron add --bad &>>/tmp/cron.log", "a bash-only append redirection"],
      ] as const
    ).map(([command, label]) => ({ toolName: "exec", command, label, expected: 0 })),
  ])(
    "counts only successful direct cron adds: $command",
    async ({ toolName, command, expected }) => {
      const { ctx } = createTestContext();
      if (expected) {
        await executeTool(ctx, {
          toolName,
          toolCallId: "tool-shell-cron-failed",
          args: { command },
          result: resultWithDetails({
            status: "completed",
            exitCode: 1,
            aggregated: "Cron job name is required.",
          }),
        });
        expect(ctx.state.successfulCronAdds).toBe(0);
      }
      await executeTool(ctx, {
        toolName,
        toolCallId: "tool-shell-cron-add",
        args: { command },
        isError: false,
        result: resultWithDetails({
          status: "completed",
          exitCode: 0,
          durationMs: 12,
          aggregated: expected ? "warning text and human-readable success output" : "completed",
        }),
      });
      expect(ctx.state.successfulCronAdds).toBe(expected);
    },
  );

  it.each(["cancelled-before-body", "policy-blocked", "middleware-rewritten"] as const)(
    "derives cron replay safety from %s execution evidence",
    async (mode) => {
      const { ctx } = createTestContext();
      const toolCallId = `tool-cron-${mode}`;
      if (mode === "cancelled-before-body") {
        recordToolExecutionTracked(toolCallId, "run-test");
      }
      await executeTool(ctx, {
        toolName: "cron",
        toolCallId,
        args: { action: "add", job: { name: "reminder" } },
        isError: mode !== "policy-blocked",
        ...(mode === "cancelled-before-body" ? { executionStarted: true } : {}),
        result:
          mode === "policy-blocked"
            ? buildBlockedToolResult({ reason: "blocked by policy", toolCallId, runId: "run-test" })
            : mode === "cancelled-before-body"
              ? { details: { status: "error", error: "cancelled before tool body" } }
              : {
                  content: [{ type: "text", text: "blocked by middleware" }],
                  details: {
                    status: "blocked",
                    deniedReason: "plugin-before-tool-call",
                    reason: "blocked by middleware",
                  },
                },
      });
      const executed = mode === "middleware-rewritten";
      expect(ctx.state.replayState).toEqual({
        replayInvalid: executed,
        hadPotentialSideEffects: executed,
      });
      expect(ctx.state.lastToolError?.mutatingAction).toBe(executed);
    },
  );

  it("records structured core read actions as replay-safe", async () => {
    for (const [toolName, action] of [
      ["cron", "status"],
      ["gateway", "config.get"],
      ["gateway", "config.schema.lookup"],
      ["nodes", "status"],
      ["nodes", "describe"],
      ["nodes", "pending"],
    ] as const) {
      const { ctx } = createTestContext();
      const toolCallId = `tool-${toolName}-${action}`;
      recordStructuredReplayTrustForToolCall(
        toolCallId,
        { name: toolName, execute: vi.fn() } as never,
        "run-test",
      );
      await executeTool(ctx, {
        toolName,
        toolCallId,
        args: { action },
        isError: false,
        result: { details: { ok: true } },
      });

      expect(ctx.state.replayState.hadPotentialSideEffects, `${toolName}.${action}`).toBe(false);
    }
  });

  it.each([false, true])(
    "requires instance replay trust for search (trusted=%s)",
    async (trusted) => {
      const { ctx } = createTestContext();
      if (trusted) {
        ctx.params.replaySafeToolNames = new Set(["search"]);
      }
      await executeTool(ctx, {
        toolName: "search",
        toolCallId: "tool-search",
        args: { query: "scheduler" },
        result: { matches: [] },
      });
      expect(ctx.state.toolMetas).toEqual([
        expect.objectContaining({ toolName: "search", replaySafe: trusted }),
      ]);
      expect(ctx.state.replayState).toEqual({
        replayInvalid: !trusted,
        hadPotentialSideEffects: !trusted,
      });
    },
  );
});

registerToolChannelProgressTests({ createTestContext, startTool, updateTool, endTool });

describe("handleToolExecutionEnd MCP App channel view tracking", () => {
  const result = (viewId: string, title: string) => ({
    details: {
      mcpAppPreview: {
        view: { id: viewId, title },
        mcpApp: { viewId },
      },
    },
  });

  it("retains only the latest successful bounded view identity", async () => {
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "mcp_first",
      toolCallId: "mcp-first",
      result: result("view-first", "First app"),
    });
    await endTool(ctx, {
      toolName: "mcp_failed",
      toolCallId: "mcp-failed",
      isError: true,
      result: result("view-failed", "Failed app"),
    });
    const invalid = result("view-invalid", "Invalid app");
    invalid.details.mcpAppPreview.view.id = "different-view";
    await endTool(ctx, {
      toolName: "mcp_invalid",
      toolCallId: "mcp-invalid",
      result: invalid,
    });
    expect(ctx.state.latestMcpAppChannelView).toEqual({ viewId: "view-first" });
    await endTool(ctx, {
      toolName: "mcp_latest",
      toolCallId: "mcp-latest",
      result: result("view-latest", "Latest app"),
    });

    expect(ctx.state.latestMcpAppChannelView).toEqual({ viewId: "view-latest" });
  });
});

describe("handleToolExecutionEnd MCP connect action tracking", () => {
  it("retains only a successful HTTP(S) connect action", async () => {
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "mcp_connect",
      toolCallId: "mcp-connect",
      result: resultWithDetails({
        mcpConnect: {
          serverName: "calendar",
          authorizationUrl: "https://auth.example/authorize?state=opaque",
        },
      }),
    });

    expect(ctx.state.latestMcpConnectAction).toEqual({
      serverName: "calendar",
      authorizationUrl: "https://auth.example/authorize?state=opaque",
    });
  });
});

describe("handleToolExecutionEnd mutating failure recovery", () => {
  it("keeps an earlier message error when the next delivery is intentionally suppressed", async () => {
    const { ctx } = createTestContext();
    await executeTool(ctx, {
      toolName: "message",
      toolCallId: "message-failed",
      args: {
        action: "send",
        channel: "telegram",
        target: "123",
        message: "failed",
        media: "/tmp/failed.png",
      },
      isError: true,
      result: resultWithDetails({
        status: "error",
        error: "Telegram transport failed",
        media: { mediaUrl: "/tmp/failed.png" },
      }),
    });
    await executeTool(ctx, {
      toolName: "message",
      toolCallId: "message-suppressed",
      args: { action: "send", channel: "telegram", target: "123", message: "omitted" },
      result: { details: { status: "suppressed", reason: "cancelled_by_message_sending_hook" } },
    });
    expect(ctx.state.messagingToolSentMediaUrls).toEqual([]);
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "message",
      error: "Telegram transport failed",
    });
  });

  it.each([
    {
      toolName: "exec",
      args: { cmd: "echo ok" },
      isError: false,
      ownerKey: undefined,
      result: {
        content: [{ type: "text", text: "Tool output unavailable due to post-processing error." }],
        details: { status: "error", middlewareError: true },
      },
      expected: { toolName: "exec", middlewareError: true },
    },
    {
      toolName: "memory_store",
      args: { text: "The user prefers metric units." },
      isError: true,
      ownerKey: '["memory-lancedb","memory_store"]',
      result: { details: { status: "error", error: "429 insufficient_quota" } },
      expected: { toolName: "memory_store", mutatingAction: true },
    },
  ])(
    "records middleware and plugin-owner failure metadata for $toolName",
    async ({ toolName, args, isError, ownerKey, result, expected }) => {
      const { ctx } = createTestContext();
      if (ownerKey) {
        ctx.params.sideEffectToolOwners = new Map([[toolName, ownerKey]]);
      }
      await executeTool(ctx, {
        toolName,
        toolCallId: "tool-failure-metadata",
        args,
        isError,
        result,
      });
      expect(ctx.state.lastToolError).toMatchObject(expected);
    },
  );

  it("clears edit failure when the retry succeeds through common file path aliases", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "edit",
      toolCallId: "tool-edit-1",
      args: {
        file_path: "/tmp/demo.txt",
        old_string: "beta stale",
        new_string: "beta fixed",
      },
      isError: true,
      result: { error: "Could not find the exact text in /tmp/demo.txt" },
    });

    expect(ctx.state.lastToolError?.toolName).toBe("edit");

    await executeTool(ctx, {
      toolName: "edit",
      toolCallId: "tool-edit-2",
      args: {
        file: "/tmp/demo.txt",
        oldText: "beta",
        newText: "beta fixed",
      },
      result: { ok: true },
    });

    expect(ctx.state.lastToolError).toBeUndefined();
    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  });

  it.each([false, true])(
    "exports validation diagnostics only before execution (started=%s)",
    async (executionStarted) => {
      const { ctx, onAgentEvent } = createTestContext();
      const error = executionStarted
        ? 'Validation failed for tool "edit":\n  - secret tool output\n\nReceived arguments:\n{}'
        : 'Validation failed for tool "edit":\n  - edits: must have required properties edits\n\nReceived arguments:\n{"path":"secret.txt","contents":"PTY_PLANTED_SECRET"}';
      await executeTool(ctx, {
        toolName: "edit",
        toolCallId: "tool-edit-validation",
        args: executionStarted ? {} : { path: "secret.txt" },
        isError: true,
        executionStarted,
        ...(executionStarted ? {} : { errorKind: "argument-validation" as const }),
        result: { details: { status: "error", error } },
      });
      if (executionStarted) {
        const resultEvent = onAgentEvent.mock.calls.find(
          ([event]) => event.stream === "tool" && event.data.phase === "result",
        )?.[0];
        expect(resultEvent?.data).not.toHaveProperty("toolErrorSummary");
      } else {
        expect(onAgentEvent).toHaveBeenCalledWith({
          stream: "tool",
          data: expect.objectContaining({
            phase: "result",
            toolErrorSummary: "edit tool validation failed: invalid arguments",
          }),
        });
      }
      expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain(
        executionStarted ? "secret tool output" : "PTY_PLANTED_SECRET",
      );
    },
  );

  it("records command sensitivity on namespaced tool results", async () => {
    const { ctx, onAgentEvent } = createTestContext();
    await executeTool(ctx, {
      toolName: "server.exec",
      toolCallId: "tool-namespaced-exec",
      args: { command: "echo private-sentinel" },
      result: { ok: true },
    });

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "tool",
      data: expect.objectContaining({
        phase: "result",
        commandBearing: true,
        isError: false,
      }),
    });
  });

  it("snapshots hook-adjusted args before result middleware can mutate them", async () => {
    const { ctx, onAgentEvent } = createTestContext();
    const toolCallId = "tool-cron-mutable-adjusted-args";
    const executedArgs = {
      action: "add",
      job: { name: "rewritten mutation" },
    };
    recordAdjustedParamsForToolCall(toolCallId, executedArgs, "run-test");

    await startTool(ctx, {
      toolName: "cron",
      toolCallId,
      args: { action: "status" },
    });
    executedArgs.action = "status";
    await endTool(ctx, {
      toolName: "cron",
      toolCallId,
      result: { ok: true },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
    expect(ctx.state.successfulCronAdds).toBe(1);
    const resultEvent = onAgentEvent.mock.calls.find(
      ([event]) => event.stream === "tool" && event.data.phase === "result",
    )?.[0];
    expect(resultEvent?.data).not.toHaveProperty("args");
  });

  it("uses hook-adjusted message arguments for delivery telemetry", async () => {
    const { ctx } = createTestContext();
    const toolCallId = "tool-message-hook-rewrite";
    const adjustedParamsKey = beforeToolCallTesting.buildAdjustedParamsKey({
      runId: "run-test",
      toolCallId,
    });
    beforeToolCallTesting.adjustedParamsByToolCallId.set(adjustedParamsKey, {
      action: "send",
      provider: "telegram",
      to: "chat-rewritten",
      text: "rewritten delivery",
      mediaUrl: "/tmp/rewritten.png",
    });

    await executeTool(ctx, {
      toolName: "message",
      toolCallId,
      args: { action: "status" },
      result: { details: { messageId: "message-rewritten" } },
    });

    expect(ctx.state.messagingToolSentTexts).toEqual(["rewritten delivery"]);
    expect(ctx.state.messagingToolSentMediaUrls).toEqual(["/tmp/rewritten.png"]);
    expect(ctx.state.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "telegram",
        to: "chat-rewritten",
        threadId: undefined,
        text: "rewritten delivery",
        mediaUrls: ["/tmp/rewritten.png"],
      },
    ]);
  });

  it.each([
    {
      action: "send",
      args: { action: "send", provider: "telegram", to: "chat-source", text: "QA-MSTEAMS-DM-OK" },
      result: { details: { ok: true, sourceReplyRoute: "current-source" } },
      expected: "qa-msteams-dm-ok",
    },
    {
      action: "poll",
      args: {
        action: "poll",
        provider: "telegram",
        target: "chat-poll",
        pollQuestion: "Preferred default?",
        pollOption: ["Tell me right away", "Only important"],
      },
      result: { ok: true, pollId: "poll-1", details: { sourceReplyRoute: "current-source" } },
      expected: "preferred default?",
    },
  ])(
    "records preview suppression only for confirmed current-source $action",
    async ({ action, args, result, expected }) => {
      const { ctx } = createTestContext();
      ctx.params.sourceReplyDeliveryMode = "automatic";
      if (action === "send") {
        await executeTool(ctx, {
          toolName: "message",
          toolCallId: "tool-message-other-route",
          args: {
            action: "send",
            provider: "telegram",
            to: "chat-other",
            text: "Other route text",
          },
          result: { details: { ok: true } },
        });
      }
      await executeTool(ctx, {
        toolName: "message",
        toolCallId: `tool-message-source-${action}`,
        args,
        result,
      });
      expect(ctx.state.currentSourceMessagingToolSentTextsNormalized).toEqual([expected]);
      if (action === "poll") {
        expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(true);
        expect(ctx.state.messagingToolSentTexts).toEqual([]);
      }
    },
  );

  it.each([
    {
      label: "the exact source route",
      accountId: "account-1",
      target: "chat123",
      threadId: "thread-1",
      expected: true,
    },
    {
      label: "the same target in another account",
      accountId: "account-2",
      target: "chat123",
      threadId: "thread-1",
      expected: false,
    },
    {
      label: "the same target in another thread",
      accountId: "account-1",
      target: "chat123",
      threadId: "thread-2",
      expected: false,
    },
    {
      label: "another target",
      accountId: "account-1",
      target: "chat456",
      threadId: "thread-1",
      expected: false,
    },
  ])("records explicit message sends only for $label", async (testCase) => {
    const { ctx } = createTestContext();
    Object.assign(ctx.params, {
      config: {},
      sourceReplyDeliveryMode: "message_tool_only",
      messageChannel: "test-channel",
      currentAccountId: "account-1",
      currentChannelId: "chat123",
      currentThreadId: "thread-1",
    });

    await executeTool(ctx, {
      toolName: "message",
      toolCallId: `tool-message-explicit-${testCase.label}`,
      args: {
        action: "send",
        channel: "test-channel",
        accountId: testCase.accountId,
        target: testCase.target,
        threadId: testCase.threadId,
        message: "explicit reply",
      },
      result: { details: { ok: true } },
    });

    expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(testCase.expected);
  });

  it("records rich-content delivery when visible text is blank", async () => {
    const { ctx } = createTestContext();
    const toolCallId = "tool-message-rich-content";

    await executeTool(ctx, {
      toolName: "message",
      toolCallId,
      args: {
        action: "send",
        provider: "telegram",
        to: "chat-rich",
        text: "  ",
        presentation: JSON.stringify({
          blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
        }),
      },
      result: { details: { messageId: "message-rich" } },
    });

    expect(ctx.state.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat-rich",
        hasRichContent: true,
      }),
    ]);
  });

  it.each([
    {
      action: "reply",
      target: "chat-reply",
      message: "visible reply",
      result: { ok: true },
      delivered: true,
    },
    {
      action: "reply",
      target: "chat-reply",
      message: "visible reply",
      result: { ok: true, dryRun: true },
      delivered: false,
    },
    {
      action: "thread-create",
      target: "chat-thread",
      message: "new thread",
      result: { ok: true, thread: { id: "thread-1" } },
      delivered: true,
    },
  ])(
    "records non-send target evidence for $action (delivered=$delivered)",
    async ({ action, target, message, result, delivered }) => {
      const { ctx } = createTestContext();
      ctx.params.sourceReplyDeliveryMode = "automatic";
      await executeTool(ctx, {
        toolName: "message",
        toolCallId: "tool-message-target",
        args: { action, provider: "telegram", target, message },
        result,
      });
      expect(ctx.state.currentSourceMessagingToolSentTextsNormalized).toEqual([]);
      expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(false);
      expect(ctx.state.messagingToolSentTexts).toEqual([]);
      expect(ctx.state.messagingToolSentMediaUrls).toEqual([]);
      expect(ctx.state.messagingToolSentTargets).toEqual(
        delivered
          ? [expect.objectContaining({ tool: "message", provider: "telegram", to: target })]
          : [],
      );
    },
  );

  it.each([
    {
      toolName: "exec",
      args: { command: "printf changed > /tmp/demo.txt && false" },
      isError: true,
      result: { error: "Command exited with code 1" },
    },
    {
      toolName: "browser",
      args: { action: "act", kind: "click", ref: "e12" },
      isError: false,
      result: { details: { ok: true } },
    },
    {
      toolName: "subagents",
      args: { action: "kill", target: "worker-1" },
      isError: false,
      result: { status: "ok", action: "kill", target: "worker-1" },
    },
    {
      toolName: "subagents",
      args: { action: "list" },
      isError: false,
      result: { status: "ok", action: "list", total: 0, text: "no active subagents." },
    },
  ])("keeps untrusted $toolName calls replay-unsafe: $args", async (event) => {
    const { ctx } = createTestContext();
    await executeTool(ctx, { toolCallId: "tool-untrusted", ...event });
    expect(ctx.state.replayState).toEqual({ replayInvalid: true, hadPotentialSideEffects: true });
  });
});

describe("handleToolExecutionEnd timeout metadata", () => {
  it("marks every finalized built-in call with its explicit outcome", async () => {
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "read",
      toolCallId: "tool-read-complete",
      result: { content: "ok" },
    });
    await endTool(ctx, {
      toolName: "process",
      toolCallId: "tool-process-running",
      result: { details: { status: "running" } },
    });
    await endTool(ctx, {
      toolName: "image_generate",
      toolCallId: "tool-image-async-started",
      result: { details: { async: true, status: "started" } },
    });
    await endTool(ctx, {
      toolName: "write",
      toolCallId: "tool-write-failed",
      isError: true,
      result: { error: "failed" },
    });

    expect(
      ctx.state.toolMetas.map(({ toolName, isError }) => ({
        toolName,
        isError,
      })),
    ).toEqual([
      { toolName: "read", isError: false },
      { toolName: "process", isError: false },
      { toolName: "image_generate", isError: false },
      { toolName: "write", isError: true },
    ]);
    expect(ctx.state.toolMetas[2]?.asyncStarted).toBe(true);
  });

  it("marks a parked Code Mode exec only when the tool is the marked control tool", async () => {
    const { ctx } = createTestContext();
    ctx.params.codeModeExecToolNames = new Set(["exec"]);

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-code-mode-waiting",
      result: { details: { status: "waiting", runId: "cm_parked", reason: "pending_tools" } },
    });
    ctx.params.codeModeExecToolNames = new Set();
    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-plain-exec-waiting",
      result: { details: { status: "waiting", runId: "cm_impostor" } },
    });

    expect(ctx.state.toolMetas.map((entry) => entry.codeModeSuspended)).toEqual([true, undefined]);
  });

  it("records intentional termination with its exact tool call id", async () => {
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "terminal_action",
      toolCallId: "tool-terminal-current",
      result: {
        content: [{ type: "text", text: "Done." }],
        details: { status: "done" },
        terminate: true,
      },
    });

    expect(ctx.state.toolMetas).toEqual([
      expect.objectContaining({
        toolName: "terminal_action",
        toolCallId: "tool-terminal-current",
        terminate: true,
      }),
    ]);
  });

  it("retains every failed call after later successes change the last-error slot", async () => {
    const { ctx } = createTestContext();

    for (const [toolCallId, isError] of [
      ["tool-write-failed", true],
      ["tool-read-failed", true],
      ["tool-read-succeeded", false],
      ["tool-exec-failed", true],
    ] as const) {
      await endTool(ctx, {
        toolName: toolCallId.split("-")[1]!,
        toolCallId,
        isError,
        result: isError ? { error: `${toolCallId} failed` } : { content: "ok" },
      });
      if (toolCallId === "tool-read-failed") {
        expect(ctx.state.lastToolError).toMatchObject({
          toolName: "read",
          error: "tool-read-failed failed",
          mutatingAction: false,
        });
      }
    }

    expect(ctx.state.toolMetas.map(({ toolName, isError }) => ({ toolName, isError }))).toEqual([
      { toolName: "write", isError: true },
      { toolName: "read", isError: true },
      { toolName: "read", isError: false },
      { toolName: "exec", isError: true },
    ]);
    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "exec",
      error: "tool-exec-failed failed",
    });
  });

  async function executeProcessResult(
    ctx: ToolHandlerContext,
    params: {
      action?: string;
      details?: Record<string, unknown>;
      isError?: boolean;
      output?: string;
    } = {},
  ) {
    const action = params.action ?? "poll";
    const output = params.output ?? "SAFE_PROCESS_STDERR";
    await executeTool(ctx, {
      toolName: "process",
      toolCallId: `tool-process-${action}`,
      args: { action, sessionId: "wild-lagoon" },
      isError: params.isError ?? true,
      result: {
        content: [{ type: "text", text: output }],
        details: {
          status: "completed",
          sessionId: "wild-lagoon",
          exitReason: "exit",
          aggregated: output,
          ...params.details,
        },
      },
    });
  }

  it.each(["log"] as const)(
    "projects a structured diagnostic from the real terminal process %s result",
    async (action) => {
      const { ctx } = createTestContext();
      const sessionId = `wild-lagoon-${action}`;
      const session = createProcessSessionFixture({
        id: sessionId,
        command: "test",
        backgrounded: true,
      });
      addSession(session);
      markExited(session, 0, null, "failed", "overall-timeout", false);

      try {
        const args = { action, sessionId } as Parameters<
          ReturnType<typeof createProcessTool>["execute"]
        >[1];
        const result = await createProcessTool().execute(`tool-real-process-${action}`, args);
        await executeTool(ctx, {
          toolName: "process",
          toolCallId: `tool-process-${action}`,
          args,
          result,
        });

        expect(ctx.state.lastToolError).toMatchObject({
          toolName: "process",
          terminalDiagnostic: {
            kind: "process",
            sessionId,
            reason: { kind: "timeout", timeoutKind: "overall-timeout" },
          },
        });
      } finally {
        deleteSession(sessionId);
      }
    },
  );

  const dummyTelegramToken = `123456:${"A".repeat(28)}WXYZ`;
  it.each([
    {
      label: "signal",
      details: { exitCode: 0, exitSignal: "SIGKILL", exitReason: "signal" },
      reason: { kind: "signal", signal: "SIGKILL" },
    },
    {
      label: "no-output timeout",
      details: {
        exitCode: 0,
        exitSignal: "SIGTERM",
        exitReason: "no-output-timeout",
        timedOut: true,
      },
      reason: { kind: "timeout", timeoutKind: "no-output-timeout" },
    },
    {
      label: "redacted output",
      details: { exitCode: 7 },
      output: `${dummyTelegramToken} ${"x".repeat(500)}`,
      reason: { kind: "exit", exitCode: 7 },
    },
    {
      label: "terminal control characters",
      details: { exitCode: 7 },
      output: "SAFE\u001b[31m_PROCESS_STDERR",
      reason: { kind: "exit", exitCode: 7 },
    },
    {
      label: "missing session",
      details: { status: "failed", sessionId: undefined, exitReason: undefined, exitCode: 7 },
      reason: undefined,
    },
    {
      label: "log without terminal provenance",
      action: "log",
      details: { exitReason: undefined, exitCode: 7, exitSignal: "SIGKILL" },
      reason: undefined,
    },
  ])(
    "projects only safe terminal process diagnostics: $label",
    async ({ label, action, details, output, reason }) => {
      const { ctx } = createTestContext();
      await executeProcessResult(ctx, {
        action,
        details,
        output: output ?? `No terminal process result for ${label}.`,
      });
      expect(ctx.state.lastToolError?.terminalDiagnostic).toEqual(
        reason ? { kind: "process", sessionId: "wild-lagoon", reason } : undefined,
      );
      if (label === "redacted output") {
        expect(ctx.state.lastToolError?.error?.length).toBeLessThanOrEqual(401);
        expect(ctx.state.lastToolError?.error).toMatch(/…$/u);
        expect(JSON.stringify(ctx.state.lastToolError)).not.toContain(dummyTelegramToken);
      } else if (label === "terminal control characters") {
        expect(ctx.state.lastToolError?.error).toBeUndefined();
      }
    },
  );

  it("projects outcome-unknown exec results as errors with typed details", async () => {
    resetAgentEventsForTest();
    const events = captureAgentEvents();
    const { ctx } = createTestContext();
    const result = {
      content: [
        {
          type: "text",
          text: "The command may have executed. Do not rerun it automatically.",
        },
      ],
      details: {
        status: "failed",
        exitCode: null,
        failureKind: "outcome-unknown",
        reason: "outcome-unknown",
        nodeInvokeFailure: {
          failureCode: "TIMEOUT",
          message: "node invoke timed out",
          nodeCommandDispatched: true,
        },
        durationMs: 10,
        aggregated: "The command may have executed. Do not rerun it automatically.",
      },
    };

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-outcome-unknown",
      result,
    });

    expect(ctx.state.toolMetas).toEqual([
      expect.objectContaining({ toolName: "exec", isError: true }),
    ]);
    const toolResult = events.find(
      (event) => event.stream === "tool" && event.data?.phase === "result",
    );
    expect(toolResult?.data).toMatchObject({
      isError: true,
      result: {
        details: {
          reason: "outcome-unknown",
          nodeInvokeFailure: {
            failureCode: "TIMEOUT",
            nodeCommandDispatched: true,
          },
        },
      },
    });
    resetAgentEventsForTest();
  });

  it.each([
    {
      name: "records raw exec metadata without exposing it in default payload warnings",
      toolCallId: "tool-exec-raw-command",
      args: { command: "python3 /tmp/audit.py" },
      meta: "run python3 /tmp/audit.py, `python3 /tmp/audit.py`",
    },
    {
      name: "records backtick commands without exposing them in default payload warnings",
      toolCallId: "tool-exec-raw-command-backticks",
      args: { command: "node -e 'console.log(1, `x`)'" },
      meta: "run node inline script, ``node -e 'console.log(1, `x`)'``",
    },
  ])("$name", async ({ toolCallId, args, meta }) => {
    const { ctx } = createTestContext();
    ctx.params.toolProgressDetail = "raw";
    await executeTool(ctx, {
      toolName: "exec",
      toolCallId,
      args,
      isError: true,
      result: {
        error: "Command exited with code 1",
        content: [{ type: "text", text: "Command exited with code 1" }],
        details: { status: "failed", exitCode: 1 },
      },
    });
    expectRecordFields(ctx.state.lastToolError, "last tool error", { toolName: "exec", meta });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      lastAssistant: undefined,
      lastToolError: ctx.state.lastToolError,
      sessionKey: "agent:unit-session",
      toolResultFormat: "markdown",
    });
    expect(payloads[0]?.text).toBe("⚠️ Exec failed (exit 1)");
  });

  it.each([
    {
      label: "structured tool error",
      result: {
        content: [{ type: "text", text: "SYSTEM_RUN_DENIED: approval required" }],
        details: {
          status: "failed",
          error: { code: "SYSTEM_RUN_DENIED", message: "approval required" },
        },
      },
      error: "approval required",
    },
    {
      label: "thrown gateway error",
      result: resultWithDetails({
        status: "error",
        error: "UNAVAILABLE: SYSTEM_RUN_DENIED: approval required",
        gatewayCode: "UNAVAILABLE",
        nodeError: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: approval required" },
      }),
      error: "UNAVAILABLE: SYSTEM_RUN_DENIED: approval required",
    },
  ])("records denial codes from $label results", async ({ result, error }) => {
    const { ctx } = createTestContext();
    await endTool(ctx, { toolName: "exec", toolCallId: "tool-exec-denied", isError: true, result });
    expectRecordFields(ctx.state.lastToolError, "last tool error", {
      toolName: "exec",
      errorCode: "SYSTEM_RUN_DENIED",
      error,
    });
  });
});

describe("handleToolExecutionEnd exec approval prompts", () => {
  it("emits a deterministic approval payload and marks assistant output suppressed", async () => {
    const { ctx, onAgentEvent } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await executeTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-approval",
      args: { command: "npm view diver name version description" },
      result: resultWithDetails({
        status: "approval-pending",
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
        expiresAtMs: 1_800_000_000_000,
        allowedDecisions: ["allow-once", "deny"],
        host: "gateway",
        command: "npm view diver name version description",
        cwd: "/tmp/work",
        warningText: "Warning: heredoc execution requires explicit approval in allowlist mode.",
      }),
    });

    const result = requireMockCallArg(onToolResult, 0, "tool result");
    expect(requireString(result.text, "tool result text")).toContain(
      "```txt\n/approve 12345678 allow-once\n```",
    );
    expectRecordFields(
      requireNestedRecord(result, "exec approval payload", ["channelData", "execApproval"]),
      "exec approval payload",
      {
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      },
    );
    expectInteractiveApprovalButtons(result, [
      {
        label: "Allow Once",
        value: "/approve 12345678-1234-1234-1234-123456789012 allow-once",
        style: "success",
      },
      {
        label: "Deny",
        value: "/approve 12345678-1234-1234-1234-123456789012 deny",
        style: "danger",
      },
    ]);
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
    expect(result.text).not.toContain("allow-always");
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "approval",
      data: expect.objectContaining({
        phase: "requested",
        status: "pending",
        itemId: "command:tool-exec-approval",
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
      }),
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "item",
      data: expect.objectContaining({
        itemId: "tool:tool-exec-approval",
        phase: "end",
        status: "blocked",
        summary: "Awaiting approval before command can run.",
      }),
    });
  });

  it("emits a deterministic unavailable payload when the initiating surface cannot approve", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    const onAgentToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    ctx.params.onAgentToolResult = onAgentToolResult;

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-unavailable",
      result: resultWithDetails({
        status: "approval-unavailable",
        reason: "no-approval-route",
        channel: "discord",
        channelLabel: "Discord",
        accountId: "work",
        host: "node",
        nodeId: "node-mac-1",
      }),
    });

    const text = requireString(
      requireMockCallArg(onToolResult, 0, "tool result").text,
      "tool result text",
    );
    expect(text).toContain("no interactive approval client is currently available");
    expect(text).toContain(
      "Print the Control UI URL with `openclaw dashboard --no-open`, open it in a browser, then use the approval inbox.",
    );
    expect(text).toContain(
      "Inspect the node's effective exec policy with `openclaw approvals get --node node-mac-1`.",
    );
    expect(text).not.toContain("/approve");
    expect(text).not.toContain("Pending command:");
    expect(text).not.toContain("Host:");
    expect(text).not.toContain("CWD:");
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "exec",
      result: expect.objectContaining({
        details: expect.objectContaining({ status: "approval-unavailable" }),
      }),
      isError: true,
    });
    expect(ctx.state.toolMetas).toEqual([
      expect.objectContaining({ toolName: "exec", isError: true }),
    ]);
    const [
      { normalizeAgentRunTerminalReceipt },
      { createUsageAccumulator },
      { createEmbeddedRunContextRecoveryState },
      { prepareEmbeddedRunTerminal },
    ] = await Promise.all([
      import("./agent-run-terminal-receipt.js"),
      import("./embedded-agent-runner/usage-accumulator.js"),
      import("./embedded-agent-runner/run/context-recovery-state.js"),
      import("./embedded-agent-runner/run/terminal-preparation.js"),
    ]);
    const prepared = prepareEmbeddedRunTerminal({
      runParams: {
        admittedRunContext: createTestAdmittedRunContext("run-test"),
        sessionId: "session-test-id",
        runId: "run-test",
        workspaceDir: "/tmp/openclaw-test",
        prompt: "run",
        trigger: "user",
        timeoutMs: 60_000,
      },
      attempt: {
        terminal: { kind: "ok" },
        sessionIdUsed: "session-test-id",
        messagesSnapshot: [],
        assistantTexts: [],
        toolMetas: ctx.state.toolMetas.flatMap(({ toolName, ...entry }) =>
          toolName ? [{ ...entry, toolName }] : [],
        ),
        lastAssistant: undefined,
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        cloudCodeAssistFormatError: false,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
      },
      provider: "openai",
      model: "gpt-5.4",
      activeErrorContext: { provider: "openai", model: "gpt-5.4" },
      authProfileStore: { version: 1, profiles: {} },
      sessionIdUsed: "session-test-id",
      outerContextTokenMeta: {},
      usageAccumulator: createUsageAccumulator(),
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      resolvedToolResultFormat: "markdown",
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });
    expect(
      normalizeAgentRunTerminalReceipt(Reflect.get(prepared.agentMeta, "terminalReceipt"))
        ?.successfulToolNames,
    ).toEqual([]);
    expect(ctx.state.deterministicApprovalPromptSent).toBe(false);
  });

  it("records an actionable failure when deterministic approval delivery rejects", async () => {
    const { ctx, warn } = createTestContext();
    ctx.params.onToolResult = vi.fn(async () => {
      throw new Error("delivery failed");
    });

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-approval-reject",
      result: resultWithDetails({
        status: "approval-pending",
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
        expiresAtMs: 1_800_000_000_000,
        host: "gateway",
        command: "npm view diver name version description",
        cwd: "/tmp/work",
      }),
    });

    expect(ctx.state.deterministicApprovalPromptSent).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to deliver exec approval prompt: delivery failed"),
    );
    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "exec",
      error: "Approval prompt delivery failed: delivery failed",
      mutatingAction: false,
    });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      lastAssistant: undefined,
      lastToolError: ctx.state.lastToolError,
      sessionKey: "agent:unit-session",
      toolResultFormat: "markdown",
    });
    expect(payloads[0]?.text).toBe("⚠️ Exec blocked");
  });

  it.each([
    [false, null, "blocked", undefined],
    [true, 12, "failed", 12],
  ] as const)(
    "projects executionStarted=%s with duration %s",
    async (executionStarted, durationMs, expectedStatus, expectedDurationMs) => {
      const { ctx, onAgentEvent } = createTestContext();
      await executeTool(ctx, {
        toolName: "exec",
        toolCallId: "tool-exec-status",
        args: { command: "exit 7" },
        isError: true,
        ...(executionStarted === undefined ? {} : { executionStarted }),
        result: { content: [], details: { status: "failed", exitCode: 7, durationMs } },
      });

      const events = onAgentEvent.mock.calls.map((call) => call[0] as CapturedAgentEvent);
      expect(
        events
          .filter((event) => event.stream === "item" && event.data?.phase === "end")
          .map((event) => event.data?.status),
      ).toEqual([expectedStatus]);
      const commandOutput = requireEvent(
        events,
        (event) => event.stream === "command_output",
        "command output event",
      ).data;
      expect([
        commandOutput?.status,
        commandOutput?.exitCode,
        commandOutput?.durationMs,
        "durationMs" in commandOutput!,
      ]).toEqual([expectedStatus, 7, expectedDurationMs, expectedDurationMs !== undefined]);
    },
  );
});

describe("handleToolExecutionEnd derived tool events", () => {
  it.each([false, true])("projects only bounded typed public progress (typed=%s)", (typed) => {
    resetAgentEventsForTest();
    const events = captureAgentEvents();
    const { ctx, onAgentEvent } = createTestContext();
    const largeProgress = "x".repeat(9000);
    const toolName = typed ? "custom_fetcher" : "web_fetch";
    const toolCallId = typed ? "tool-large-progress" : "tool-web-fetch-untyped";
    updateTool(ctx, {
      toolName,
      toolCallId,
      partialResult: typed
        ? {
            content: [],
            details: undefined,
            progress: { text: largeProgress, visibility: "channel", privacy: "public" },
          }
        : { content: [{ type: "text", text: "Fetching page content..." }], details: undefined },
    });
    const itemEvent = requireRecord(
      onAgentEvent.mock.calls.map(([event]) => event).find((event) => event.stream === "item"),
      "tool item event",
    );
    const item = requireRecord(itemEvent.data, "tool item data");
    if (typed) {
      const progressText = requireString(item.progressText, "progress text");
      expect(progressText).toContain("...(live output truncated)...");
      expect(progressText.length).toBeLessThan(largeProgress.length);
      expectRecordFields(item, "progress item", {
        itemId: `tool:${toolCallId}`,
        phase: "update",
        kind: "tool",
        name: toolName,
        status: "running",
      });
      expect(item.meta).toBeUndefined();
    } else {
      expect(item.progressText).toBeUndefined();
    }
    expect(
      events.filter((event) => event.stream === "tool" && event.data?.phase === "update"),
    ).toHaveLength(typed ? 0 : 1);
    expect(
      onAgentEvent.mock.calls.map(([event]) => event).filter((event) => event.stream === "tool"),
    ).toHaveLength(typed ? 0 : 1);
    resetAgentEventsForTest();
  });

  it.each(["meta", "commandBearing", "hideFromChannelProgress"] as const)(
    "keeps exec %s changes timely while bounding and redacting its output lifecycle",
    async (field) => {
      resetAgentEventsForTest();
      const events: Array<{ stream?: string; ts?: number; data?: Record<string, unknown> }> = [];
      const unsubscribe = registerAgentEventListener((event) => events.push(event));
      const { ctx, onAgentEvent } = createTestContext();
      const toolCallId = "exec-lifecycle";
      const output =
        'OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789\napiKey: "ghp_abcdefghij1234567890"\n' +
        "x".repeat(9000);
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        await startTool(ctx, {
          toolName: "exec",
          toolCallId,
          args: { command: "cat ~/.openclaw/openclaw.json" },
        });
        const update: ToolExecutionUpdateEvent = {
          toolName: "exec",
          toolCallId,
          partialResult: { details: { status: "running", aggregated: output } },
        };
        updateTool(ctx, update);
        const metadata = ctx.state.toolMetaById.get(toolCallId);
        if (!metadata) {
          throw new Error("Expected active tool metadata");
        }
        const changedValue =
          field === "meta" ? "changed command" : field === "hideFromChannelProgress";
        if (field === "meta") {
          metadata.meta = "changed command";
        } else if (field === "commandBearing") {
          metadata.commandBearing = false;
        } else {
          update.hideFromChannelProgress = true;
        }
        for (const now of [1100, 1200, 1250, 1251]) {
          clock.mockReturnValue(now);
          updateTool(ctx, update);
        }
        await endTool(ctx, {
          toolName: "exec",
          toolCallId,
          result: resultWithDetails({
            status: "completed",
            aggregated: output,
            exitCode: 0,
            durationMs: 12,
            cwd: "/tmp/work",
          }),
        });
        const itemUpdates = events.filter(
          (event) => event.stream === "item" && event.data?.phase === "update",
        );
        expect(itemUpdates.map((event) => event.ts)).toEqual([1000, 1100, 1250]);
        expect(itemUpdates.map((event) => event.data?.kind)).toEqual(["tool", "tool", "tool"]);
        expect(itemUpdates[1]?.data?.[field]).toBe(changedValue);
        const updates = events.filter(
          (event) => event.stream === "tool" && event.data?.phase === "update",
        );
        expect(updates.map((event) => event.ts)).toEqual([1000, 1250]);
        const liveOutput = requireNestedRecord(updates[0]?.data, "update", [
          "partialResult",
          "details",
        ]).aggregated;
        const resultEvent = requireEvent(
          events,
          (event) => event.stream === "tool" && event.data?.phase === "result",
          "result",
        );
        const finalOutput = requireNestedRecord(resultEvent.data, "result", [
          "result",
          "details",
        ]).aggregated;
        const commandEvents = onAgentEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.stream === "command_output");
        expect(commandEvents.map((event) => event.data.phase)).toEqual(["delta", "delta", "end"]);
        for (const text of [
          liveOutput,
          finalOutput,
          ...commandEvents.map((event) => event.data.output),
        ]) {
          expect(text).toContain("...(live output truncated)...");
          expect(requireString(text, "bounded output").length).toBeLessThan(output.length);
          expect(text).not.toContain("sk-or-v1-abcdef0123456789");
          expect(text).not.toContain("ghp_abcdefghij1234567890");
          expect(text).toContain("OPENROUTER_API_KEY=");
        }
        expect(commandEvents.at(-1)?.data).toMatchObject({
          itemId: "command:exec-lifecycle",
          status: "completed",
          exitCode: 0,
          durationMs: 12,
          cwd: "/tmp/work",
        });
        for (const stream of ["tool", "item"]) {
          expect(
            onAgentEvent.mock.calls
              .map(([event]) => event)
              .filter((event) => event.stream === stream && event.data.phase === "update"),
          ).toHaveLength(5);
        }
        expect(events.slice(-3).map((event) => [event.stream, event.data?.phase])).toEqual([
          ["tool", "result"],
          ["item", "end"],
          ["command_output", "end"],
        ]);
        expect(ctx.state.itemActiveIds.size).toBe(0);
        expect(ctx.state.itemCompletedCount).toBe(ctx.state.itemStartedCount);
      } finally {
        clock.mockRestore();
        unsubscribe();
        resetAgentEventsForTest();
      }
    },
  );

  it("emits patch summary events for apply_patch results", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await executeTool(ctx, {
      toolName: "apply_patch",
      toolCallId: "tool-patch-summary",
      args: { patch: "*** Begin Patch" },
      result: resultWithDetails({
        summary: {
          added: ["a.ts"],
          modified: ["b.ts"],
          deleted: ["c.ts"],
        },
      }),
    });

    const patchEvent = requireRecord(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .find((event) => (event as { stream?: string })?.stream === "patch"),
      "patch event",
    );
    expectRecordFields(patchEvent.data, "patch event data", {
      itemId: "patch:tool-patch-summary",
      added: ["a.ts"],
      modified: ["b.ts"],
      deleted: ["c.ts"],
      summary: "1 added, 1 modified, 1 deleted",
    });
  });
});

describe("messaging tool media URL tracking", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it.each([
    { label: "suppressed adapter thread", currentThreadId: undefined },
    { label: "prepared native topic", currentThreadId: "42" },
  ])("keeps the $label independent from scoped session identity", async ({ currentThreadId }) => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            threading: {
              resolveAutoThreadId: ({
                toolContext,
              }: {
                toolContext?: { currentThreadTs?: string };
              }) => toolContext?.currentThreadTs,
            },
          },
          source: "test",
        },
      ]),
    );
    const { ctx } = createTestContext();
    Object.assign(ctx.params, {
      sessionKey: "agent:main:main:thread:1234:42",
      messageChannel: "telegram",
      currentChannelId: "1234",
      currentMessagingTarget: "1234",
      currentThreadId,
      replyToMode: "all",
    });
    const toolCallId = `tool-message-scoped-thread-${currentThreadId ?? "none"}`;

    await startTool(ctx, {
      toolName: "message",
      toolCallId,
      args: { action: "send", to: "1234", message: "thread ownership" },
    });

    await endTool(ctx, {
      toolName: "message",
      toolCallId,
      result: { details: { messageId: "message-scoped-thread" } },
    });

    expect(requireSingleMessagingTarget(ctx).threadId).toBe(currentThreadId);
  });

  it("preserves the pre-send reply state when committing implicit thread evidence", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            messaging: { normalizeTarget: (raw: string) => raw.trim().toLowerCase() },
            threading: {
              resolveAutoThreadId: ({
                toolContext,
              }: {
                toolContext?: {
                  currentThreadTs?: string;
                  replyToMode?: "off" | "first" | "all" | "batched";
                  hasRepliedRef?: { value: boolean };
                };
              }) =>
                toolContext?.replyToMode === "first" && !toolContext.hasRepliedRef?.value
                  ? toolContext.currentThreadTs
                  : undefined,
            },
          },
          source: "test",
        },
      ]),
    );
    const { ctx } = createTestContext();
    ctx.params.messageChannel = "slack";
    ctx.params.currentChannelId = "D1";
    ctx.params.currentMessagingTarget = "user:u1";
    ctx.params.currentThreadId = "171.222";
    ctx.params.replyToMode = "first";
    ctx.params.hasRepliedRef = { value: false };

    await startTool(ctx, {
      toolName: "message",
      toolCallId: "tool-first-threaded-message",
      args: {
        action: "send",
        to: "user:U1",
        content: "hi",
      },
    });
    ctx.params.hasRepliedRef.value = true;
    await endTool(ctx, {
      toolName: "message",
      toolCallId: "tool-first-threaded-message",
      result: { details: { messageId: "message-1" } },
    });

    expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
      provider: "slack",
      to: "user:u1",
      threadId: "171.222",
      threadImplicit: true,
      text: "hi",
    });
  });

  it("reconciles unresolved send targets from successful provider results", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "mattermost",
          plugin: {
            ...createChannelTestPluginBase({ id: "mattermost" }),
            actions: {
              extractToolSend: ({ args }: { args: Record<string, unknown> }) =>
                args.action === "send" && typeof args.to === "string"
                  ? { to: args.to, threadImplicit: true }
                  : null,
              extractToolSendResult: ({ result }: { result: unknown }) => {
                const providerResult = result as {
                  status?: string;
                  details?: { redacted?: boolean; toolSend?: unknown };
                };
                if (providerResult.status !== "sent" || providerResult.details?.redacted !== true) {
                  return null;
                }
                const details = providerResult.details;
                return (details?.toolSend as { to: string; threadId?: string } | undefined) ?? null;
              },
            },
          },
          source: "test",
        },
      ]),
    );
    const { ctx } = createTestContext();
    ctx.consumeToolSendReceipt = () => ({
      details: {
        toolSend: {
          to: "channel:resolved-id",
          threadId: "root-1",
        },
      },
    });

    await executeTool(ctx, {
      toolName: "message",
      toolCallId: "tool-mattermost-name",
      args: {
        action: "send",
        provider: "mattermost",
        to: "town-square",
        content: "hi",
      },
      result: {
        status: "sent",
        details: { redacted: true },
      },
    });

    expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
      provider: "mattermost",
      to: "channel:resolved-id",
      threadId: "root-1",
      text: "hi",
    });
  });

  it.each([
    {
      name: "result payload",
      args: { action: "send", to: "channel:123", content: "hi" },
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              mediaUrls: ["file:///img-a.jpg", "file:///img-b.jpg"],
            }),
          },
        ],
      },
      text: "hi",
      provider: undefined,
      mediaUrls: ["file:///img-a.jpg", "file:///img-b.jpg"],
    },
    {
      name: "upload and attachment paths",
      args: {
        action: "upload-file",
        channel: "discord",
        to: "channel:123",
        message: "track ready",
        path: "/tmp/generated-song.mp3",
        attachments: [{ filePath: "/tmp/generated-cover.png" }],
      },
      result: { ok: true },
      text: "track ready",
      provider: "discord",
      mediaUrls: ["/tmp/generated-song.mp3", "/tmp/generated-cover.png"],
    },
  ])(
    "commits media delivery evidence from $name",
    async ({ args, result, text, provider, mediaUrls }) => {
      const { ctx } = createTestContext();
      await executeTool(ctx, { toolName: "message", toolCallId: "tool-media", args, result });
      expect(ctx.state.messagingToolSentMediaUrls).toEqual(mediaUrls);
      expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
        ...(provider === undefined ? {} : { provider }),
        to: "channel:123",
        text,
        mediaUrls,
      });
    },
  );

  it("commits internal-ui source replies from successful message sends", async () => {
    const { ctx } = createTestContext();
    ctx.params.sourceReplyDeliveryMode = "message_tool_only";
    ctx.consumeToolSendReceipt = () => ({
      details: {
        messageDelivery: {
          status: "settled",
          partialDelivery: false,
          createdThreadIds: [],
        },
      },
    });

    await executeTool(ctx, {
      toolName: "message",
      toolCallId: "tool-internal-source-reply",
      args: { action: "send", message: "visible in tui" },
      result: resultWithDetails({
        status: "ok",
        deliveryStatus: "sent",
        sourceReplySink: "internal-ui",
        idempotencyKey: "stable-source-reply",
        sourceReply: {
          text: "visible in tui",
          mediaUrls: ["file:///tmp/reply.png"],
          channelData: { source: "tui" },
        },
      }),
    });

    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([
      {
        text: "visible in tui",
        mediaUrls: ["file:///tmp/reply.png"],
        channelData: { source: "tui" },
        idempotencyKey: "stable-source-reply",
        sourceReplyFinal: true,
      },
    ]);
  });

  it.each([
    {
      kind: "widget",
      presentation: {
        target: "current_channel",
        receipt: {
          primaryPlatformMessageId: "discord-message-1",
          platformMessageIds: ["discord-message-1"],
          parts: [],
          sentAt: 1,
        },
      },
      delivered: true,
    },
    {
      kind: "canvas",
      presentation: { target: "assistant_message", title: "Status", sandbox: "scripts" },
      view: { id: "cv_1", url: "/__openclaw__/canvas/documents/cv_1/index.html" },
      delivered: false,
    },
  ])(
    "records source delivery only for current-channel widgets ($kind)",
    async ({ delivered, ...details }) => {
      const { ctx } = createTestContext();
      const onDeliveredMessageToolOnlySourceReply = vi.fn();
      Object.assign(ctx.params, {
        sourceReplyDeliveryMode: "message_tool_only",
        coreBuiltinToolNames: new Set(["show_widget"]),
        onDeliveredMessageToolOnlySourceReply,
      });
      await executeTool(ctx, {
        toolName: "show_widget",
        toolCallId: "tool-widget",
        args: { title: "Status", widget_code: "<p>ready</p>" },
        result: resultWithDetails(details),
      });
      expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(delivered);
      expect(onDeliveredMessageToolOnlySourceReply).toHaveBeenCalledTimes(delivered ? 1 : 0);
    },
  );

  it.each([
    {
      name: "payload-only",
      delivery: {
        channel: "googlechat",
        to: "spaces/AAA",
        ok: true,
        payload: { ok: true, messageId: "plugin-message-1" },
      },
      expected: {
        status: "settled",
        primaryPlatformMessageId: "plugin-message-1",
        partialDelivery: false,
        createdThreadIds: [],
      },
      message: "visible after redaction",
      isError: false,
    },
    {
      name: "partial broadcast",
      delivery: {
        channel: "googlechat",
        to: "spaces/AAA",
        ok: false,
        sentBeforeError: true as const,
      },
      expected: { status: "settled", partialDelivery: true, createdThreadIds: [] },
      message: "visible before failure",
      isError: true,
    },
  ])(
    "commits $name delivery after middleware replaces details",
    async ({ delivery, expected, message, isError }) => {
      const { ctx } = createTestContext();
      ctx.params.sourceReplyDeliveryMode = "message_tool_only";
      const messageDelivery = projectEmbeddedMessageDeliveryFact({
        kind: "broadcast",
        channel: "googlechat",
        action: "broadcast",
        handledBy: "core",
        payload: { results: [delivery] },
        dryRun: false,
      });
      expect(messageDelivery).toEqual(expected);
      ctx.consumeToolSendReceipt = () => ({ details: { messageDelivery } });
      await executeTool(ctx, {
        toolName: "message",
        toolCallId: "tool-private-broadcast",
        args: { action: "send", message },
        isError,
        result: { details: { redacted: true } },
      });
      expect(ctx.state.messagingToolSentTexts).toEqual([message]);
      expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(true);
    },
  );

  it("does not commit dry-run or external message sends as internal-ui source replies", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "message",
      toolCallId: "tool-dry-run-source-reply",
      args: { action: "send", message: "preview" },
      result: resultWithDetails({
        status: "ok",
        deliveryStatus: "dry_run",
        sourceReplySink: "internal-ui",
        sourceReply: { text: "preview" },
      }),
    });

    await executeTool(ctx, {
      toolName: "message",
      toolCallId: "tool-external-source-reply",
      args: { action: "send", to: "channel:123", message: "sent externally" },
      result: resultWithDetails({
        status: "ok",
        deliveryStatus: "sent",
        sourceReply: { text: "sent externally" },
      }),
    });

    expect(ctx.state.messagingToolSourceReplyPayloads).toHaveLength(0);
  });
});

describe("control UI credential redaction (issue #72283)", () => {
  afterEach(() => {
    resetAgentEventsForTest();
  });

  it.each([
    {
      name: "structured",
      result: resultWithDetails({ config: { apiKey: "sk-1234567890abcdefXYZ", model: "gpt-4" } }),
      secret: "sk-1234567890abcdefXYZ",
      visible: "gpt-4",
    },
    {
      name: "primitive",
      result: "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789",
      secret: "sk-or-v1-abcdef0123456789",
      visible: "OPENROUTER_API_KEY=",
    },
  ])("redacts gateway arguments and $name results", async ({ result, secret, visible }) => {
    const events = captureAgentEvents();
    const { ctx } = createTestContext();
    ctx.shouldEmitToolOutput = () => typeof result === "string";
    if (typeof result !== "string") {
      await startTool(ctx, {
        toolName: "gateway",
        toolCallId: "tool-secret",
        args: {
          action: "config.apply",
          raw: 'apiKey: "sk-1234567890abcdefXYZ"',
          headers: { Authorization: "Bearer abcdef0123456789QWERTY=" },
        },
      });
    }
    await endTool(ctx, { toolName: "gateway", toolCallId: "tool-secret", result });
    const emittedResult = requireEvent(
      events,
      (event) => event.stream === "tool" && event.data?.phase === "result",
      "tool result",
    ).data?.result;
    expect(JSON.stringify(emittedResult)).not.toContain(secret);
    expect(JSON.stringify(emittedResult)).toContain(visible);
    if (typeof result === "string") {
      expect(typeof emittedResult).toBe("string");
      expect(ctx.emitToolOutput).toHaveBeenCalledWith("gateway", undefined, emittedResult, result);
    } else {
      const startEvent = requireEvent(
        events,
        (event) => event.stream === "tool" && event.data?.phase === "start",
        "tool start",
      );
      const serialized = JSON.stringify(startEvent.data?.args ?? {});
      expect(serialized).not.toContain("sk-1234567890abcdefXYZ");
      expect(serialized).not.toContain("abcdef0123456789QWERTY=");
      expect(serialized).toContain("config.apply");
    }
  });
});

function createMediaContext(
  overrides: {
    shouldEmitToolOutput?: boolean;
    onToolResult?: NonNullable<ToolHandlerContext["params"]["onToolResult"]>;
    toolResultFormat?: "markdown" | "plain";
    builtinToolNames?: ReadonlySet<string>;
    coreBuiltinToolNames?: ReadonlySet<string>;
    trustedLocalMediaToolNames?: ReadonlySet<string>;
  } = {},
): ToolHandlerContext {
  const { ctx } = createTestContext();
  ctx.params.onToolResult =
    overrides.onToolResult ?? vi.fn<NonNullable<ToolHandlerContext["params"]["onToolResult"]>>();
  ctx.params.toolResultFormat = overrides.toolResultFormat;
  ctx.params.coreBuiltinToolNames = overrides.coreBuiltinToolNames;
  ctx.builtinToolNames = overrides.builtinToolNames;
  ctx.trustedLocalMediaToolNames =
    overrides.trustedLocalMediaToolNames ?? overrides.builtinToolNames;
  ctx.shouldEmitToolOutput = () => overrides.shouldEmitToolOutput ?? false;
  ctx.state.pendingToolMediaAttachments = [];
  return ctx;
}

async function emitPngMediaToolResult(ctx: ToolHandlerContext) {
  await endTool(ctx, {
    toolName: "browser",
    toolCallId: "media-image",
    result: {
      content: [
        { type: "text", text: "Screenshot saved." },
        { type: "image", data: "base64", mimeType: "image/png" },
      ],
      details: { path: "/tmp/screenshot.png" },
    },
  });
}

function firstEmitToolOutputCall(ctx: ToolHandlerContext) {
  expect(ctx.emitToolOutput).toHaveBeenCalledTimes(1);
  const call = vi.mocked(ctx.emitToolOutput).mock.calls[0];
  if (!call) {
    throw new Error("expected emitToolOutput call");
  }
  return call;
}

describe("handleToolExecutionEnd media emission", () => {
  it.each([false, true])("routes image fallback media with verbose output %s", async (verbose) => {
    const onToolResult = vi.fn();
    const ctx = createMediaContext({ shouldEmitToolOutput: verbose, onToolResult });
    await emitPngMediaToolResult(ctx);
    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.emitToolOutput).toHaveBeenCalledTimes(verbose ? 1 : 0);
    expect(ctx.state.pendingToolMediaUrls).toStrictEqual(verbose ? [] : ["/tmp/screenshot.png"]);
  });

  it("aligns retained attachment metadata after filtering local media and merging duplicates", async () => {
    const ctx = createMediaContext();
    ctx.state.pendingToolMediaUrls.push("https://example.com/existing.png");
    ctx.state.pendingToolMediaAttachments?.push({});

    await endTool(ctx, {
      toolName: "plugin_tool",
      toolCallId: "generated-media",
      result: resultWithDetails({
        media: {
          mediaUrls: [
            "/tmp/private.png",
            "https://example.com/existing.png",
            "https://example.com/video.mp4",
          ],
          attachments: [
            { type: "image", path: "/tmp/private.png", name: "private.png" },
            {
              type: "image",
              url: "https://example.com/existing.png",
              name: "existing.png",
              width: 320,
            },
            {
              type: "video",
              url: "https://example.com/video.mp4",
              name: "friendly-video.mp4",
              durationMs: 5_000,
              width: 1280,
              height: 720,
              trustedLocalMedia: true,
            },
          ],
        },
      }),
    });

    expect(ctx.state.pendingToolMediaUrls).toEqual([
      "https://example.com/existing.png",
      "https://example.com/video.mp4",
    ]);
    expect(ctx.state.pendingToolMediaAttachments).toEqual([
      {
        type: "image",
        url: "https://example.com/existing.png",
        name: "existing.png",
        width: 320,
      },
      {
        type: "video",
        url: "https://example.com/video.mp4",
        name: "friendly-video.mp4",
        durationMs: 5_000,
        width: 1280,
        height: 720,
      },
    ]);
    expect(ctx.state.pendingToolMediaTrustByUrl.get("https://example.com/video.mp4")).toBe(false);
  });

  it.each([
    {
      name: "case-variant collision",
      toolName: "Web_Search",
      builtinToolNames: new Set(["web_search"]),
      provenance: {},
    },
    {
      name: "MCP provenance",
      toolName: "browser",
      builtinToolNames: undefined,
      provenance: { mcpServer: "probe", mcpTool: "browser" },
    },
  ])("rejects local media with $name", async ({ toolName, builtinToolNames, provenance }) => {
    const onToolResult = vi.fn();
    const ctx = createMediaContext({ shouldEmitToolOutput: false, onToolResult, builtinToolNames });
    await endTool(ctx, {
      toolName,
      toolCallId: "media-untrusted",
      result: {
        content: [{ type: "text", text: "Generated media." }],
        details: { media: { mediaUrl: "/tmp/secret.png" }, ...provenance },
      },
    });
    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toStrictEqual([]);
  });

  it("queues one voice copy when TTS output text mentions the generated file", async () => {
    const ctx = createMediaContext({
      shouldEmitToolOutput: true,
      onToolResult: vi.fn(),
      toolResultFormat: "plain",
      builtinToolNames: new Set(["tts"]),
      coreBuiltinToolNames: new Set(["tts"]),
    });

    await endTool(ctx, {
      toolName: "tts",
      toolCallId: "tc-1",
      result: markCoreTtsToolResult(
        {
          content: [{ type: "text", text: "Generated audio reply at /tmp/reply.opus" }],
          details: {
            media: {
              mediaUrl: "/tmp/reply.opus",
              audioAsVoice: true,
              trustedLocalMedia: true,
            },
          },
        },
        ["/tmp/reply.opus"],
      ),
    });

    expect(ctx.emitToolOutput).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
    expect(ctx.state.toolAutoDeliveryMediaUrls).toEqual(new Set(["/tmp/reply.opus"]));
    expect(ctx.state.pendingToolMediaTrustByUrl.get("/tmp/reply.opus")).toBe(true);
  });

  it("does not grant auto-delivery to a trusted plugin tts when core tts is present", async () => {
    const ctx = createMediaContext({
      shouldEmitToolOutput: false,
      builtinToolNames: new Set(["tts"]),
      coreBuiltinToolNames: new Set(["tts"]),
      trustedLocalMediaToolNames: new Set(["tts"]),
    });

    await endTool(ctx, {
      toolName: "tts",
      toolCallId: "plugin-tts",
      result: resultWithDetails({
        media: {
          mediaUrl: "/tmp/plugin.opus",
          audioAsVoice: true,
          trustedLocalMedia: true,
        },
      }),
    });

    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/plugin.opus"]);
    expect(ctx.state.toolAutoDeliveryMediaUrls).toEqual(new Set());
  });

  it.each([
    {
      toolName: "TTS",
      builtin: "tts",
      text: "(spoken) hello",
      mediaUrl: "/tmp/reply.opus",
      accepted: false,
    },
    {
      toolName: "tts",
      builtin: "web_search",
      text: "remote tool output",
      mediaUrl: "https://example.com/reply.opus",
      accepted: true,
    },
  ])(
    "keeps verbose text for untrusted TTS media $mediaUrl",
    async ({ toolName, builtin, text, mediaUrl, accepted }) => {
      const ctx = createMediaContext({
        shouldEmitToolOutput: true,
        onToolResult: vi.fn(),
        toolResultFormat: "plain",
        builtinToolNames: new Set([builtin]),
      });
      await endTool(ctx, {
        toolName,
        toolCallId: "tc-1",
        result: {
          content: [{ type: "text", text }],
          details: { media: { mediaUrl, audioAsVoice: true } },
        },
      });
      expect(firstEmitToolOutputCall(ctx)).toEqual([toolName, undefined, text, undefined]);
      expect(ctx.state.pendingToolMediaUrls).toStrictEqual(accepted ? [mediaUrl] : []);
      expect(ctx.state.pendingToolAudioAsVoice).toBe(accepted);
      expect(ctx.state.toolAutoDeliveryMediaUrls).toEqual(new Set());
    },
  );

  it("queues trusted bundled plugin media even when plain verbose output is emitted", async () => {
    const ctx = createMediaContext({
      shouldEmitToolOutput: true,
      toolResultFormat: "plain",
      trustedLocalMediaToolNames: new Set(["plugin_media_tool"]),
    });

    await endTool(ctx, {
      toolName: "plugin_media_tool",
      toolCallId: "tc-1",
      result: {
        content: [
          {
            type: "text",
            text: "Meeting audio attached.",
          },
        ],
        details: {
          media: {
            mediaUrls: ["/tmp/meeting.wav"],
          },
        },
      },
    });

    expect(ctx.emitToolOutput).toHaveBeenCalledTimes(1);
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/meeting.wav"]);
  });

  it.each([true, false])(
    "admits omitted-name TTS media only with core provenance (%s)",
    async (owned) => {
      const ctx = createMediaContext({
        shouldEmitToolOutput: false,
        onToolResult: vi.fn(),
        builtinToolNames: new Set(["web_search"]),
      });

      const result = {
        content: [{ type: "text", text: "(spoken) hello" }],
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            audioAsVoice: true,
            trustedLocalMedia: true,
          },
        },
      };
      await endTool(ctx, {
        toolName: "tts",
        toolCallId: "tc-1",
        result: owned ? markCoreTtsToolResult(result, ["/tmp/reply.opus"]) : result,
      });

      expect(ctx.state.pendingToolMediaUrls).toEqual(owned ? ["/tmp/reply.opus"] : []);
      expect(ctx.state.pendingToolAudioAsVoice).toBe(owned);
      expect(ctx.state.pendingToolMediaTrustByUrl.get("/tmp/reply.opus")).toBe(
        owned ? true : undefined,
      );
      expect(ctx.state.toolAutoDeliveryMediaUrls).toEqual(
        new Set(owned ? ["/tmp/reply.opus"] : []),
      );
    },
  );
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
