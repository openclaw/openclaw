import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as mcp from "../../gateway/mcp-http.loopback-runtime.js";
import { onAgentEventForRun } from "../../infra/agent-events.js";
import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "../embedded-agent-runner/result-fallback-classifier.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
import { buildCliRunResult } from "./cli-run-settlement.js";
import {
  closePluginTestAdmissions,
  createExecution,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import { prepareCliRunTerminalReply } from "./terminal-reply.js";

afterEach(closePluginTestAdmissions);

function message(role: "assistant" | "user", content: Record<string, unknown>[]) {
  return { type: role, message: { role, content } };
}

it.each([
  [true, "Late duplicate reply"],
  [false, "Late duplicate reply"],
  [false, "HEARTBEAT_OK"],
] as const)("settles yield after receipt (%s, %s)", async (interruptible, lateReply) => {
  const order: string[] = [];
  const interrupt = async (reason: string) => {
    order.push(reason);
  };
  const { context } = await createExecution();
  context.mcpDeliveryCapture = true;
  context.preparedBackend.backend.command = process.execPath;
  context.backendResolved.runtimeArtifact = {
    kind: "bundled-package-tree",
    packageName: "@fixture/cli-yield",
    entrypoint: "command",
    nativeExecutableNames: [path.basename(process.execPath)],
  };
  context.authBindingFingerprint = "fixture-owner";
  context.params.onSuccessfulAuthBinding = vi.fn();
  const execute: CliBackendExecute = async function* (execution) {
    if (interruptible) {
      execution.registerTurnInterrupt?.({ interrupt });
    }
    yield { type: "system", subtype: "init", session_id: "sdk-session" };
    yield message("assistant", [
      { type: "tool_use", id: "yield-1", name: "mcp__openclaw__sessions_yield", input: {} },
    ]);
    const request = mcp.markMcpLoopbackRequestStarted(execution.env.OPENCLAW_MCP_CLI_CAPTURE_KEY);
    const tool = { toolName: "sessions_yield", args: {} };
    const call = mcp.markMcpLoopbackToolCallStarted({ requestCaptureHandle: request, ...tool });
    const yieldContext = mcp.resolveMcpLoopbackYieldContext(request);
    if (!call || !yieldContext) {
      throw new Error("Missing production MCP capture");
    }
    await yieldContext.onYield("Wait for children", "Research is running.");
    const result = { content: [{ type: "text", text: '{"status":"yielded"}' }] };
    mcp.recordMcpLoopbackToolCallResult({
      captureHandle: call,
      ...tool,
      outcome: "completed",
      result,
    });
    mcp.markMcpLoopbackToolCallFinished(call);
    mcp.markMcpLoopbackRequestFinished(request);
    order.push("answered");
    const receipt = message("user", [{ type: "tool_result", tool_use_id: "yield-1", ...result }]);
    yield receipt;
    yield receipt;
    yield message("assistant", [{ type: "text", text: lateReply }]);
    yield { ...SUCCESS_RESULT, result: lateReply };
  };
  context.executionTarget = { kind: "plugin", execute };
  const assistantEvents: unknown[] = [];
  const stop = onAgentEventForRun(context.params.runId, (event) => {
    if (event.stream === "assistant") {
      assistantEvents.push(event.data);
    }
  });
  const output = await executePreparedCliRun(context).finally(stop);
  const result = buildCliRunResult({
    context,
    output,
    preparedReply: prepareCliRunTerminalReply(context, output),
    effectiveCliSessionId: output.sessionId,
    usedHistoryPrompt: false,
    userTurnHandled: true,
    sessionBindingDisabled: false,
    preparedContextAgentMeta: {},
  });
  const attempts: string[] = [];
  const outcome = await runWithModelFallback({
    cfg: undefined,
    provider: "external",
    model: "primary",
    fallbacksOverride: ["external/fallback"],
    skipAuthProfileRuntime: true,
    run: async (_provider, model) => {
      attempts.push(model);
      return result;
    },
    classifyResult: classifyEmbeddedAgentRunResultForModelFallback,
  });
  expect(order).toEqual(interruptible ? ["answered", "yield"] : ["answered"]);
  expect(attempts).toEqual(["primary"]);
  expect(outcome.attempts).toEqual([]);
  if (interruptible) {
    expect(assistantEvents).toEqual([]);
  }
  expect(context.params.onSuccessfulAuthBinding).toHaveBeenCalledOnce();
  expect(result.payloads).toEqual(interruptible ? undefined : [{ text: lateReply }]);
  expect(result.meta).toMatchObject({
    yielded: true,
    stopReason: "end_turn",
    livenessState: "paused",
    yieldAcknowledgment: "Research is running.",
    agentMeta: { sessionId: "sdk-session", cliSessionBinding: { sessionId: "sdk-session" } },
  });
});

it.each([true, false])(
  "ends the turn after a mirrored final WebChat reply (interruptible %s)",
  async (interruptible) => {
    const order: string[] = [];
    const { context } = await createExecution();
    context.mcpDeliveryCapture = true;
    context.params.messageChannel = "webchat";
    context.params.terminalReplyExpectation = "result-required";
    const lateReply = "I sent the answer with the message tool.";
    const execute: CliBackendExecute = async function* (execution) {
      if (interruptible) {
        execution.registerTurnInterrupt?.({
          interrupt: async (reason) => {
            order.push(reason);
          },
        });
      }
      yield { type: "system", subtype: "init", session_id: "sdk-session" };
      const args = { action: "send", message: "Die Hauptstadt ist Paris.", final: true };
      yield message("assistant", [
        { type: "tool_use", id: "send-1", name: "mcp__openclaw__message", input: args },
      ]);
      const key = execution.env.OPENCLAW_MCP_CLI_CAPTURE_KEY;
      const request = mcp.markMcpLoopbackRequestStarted(key);
      const call = mcp.markMcpLoopbackToolCallStarted({
        requestCaptureHandle: request,
        toolName: "message",
        args,
      });
      if (!call) {
        throw new Error("Missing production MCP capture");
      }
      const result = {
        content: [{ type: "text", text: "sent" }],
        details: {
          deliveryStatus: "sent",
          sourceReplySink: "internal-ui",
          sourceReply: { text: "Die Hauptstadt ist Paris." },
          messageDelivery: {
            status: "settled",
            partialDelivery: false,
            createdThreadIds: [],
            sourceReplyDelivered: true,
          },
        },
      };
      mcp.recordMcpLoopbackToolCallResult({
        captureHandle: call,
        toolName: "message",
        args,
        outcome: "completed",
        result,
      });
      mcp.markMcpLoopbackToolCallFinished(call);
      mcp.markMcpLoopbackRequestFinished(request);
      yield message("user", [{ type: "tool_result", tool_use_id: "send-1", ...result }]);
      order.push("receipt");
      yield message("assistant", [{ type: "text", text: lateReply }]);
      yield { ...SUCCESS_RESULT, result: lateReply };
    };
    context.executionTarget = { kind: "plugin", execute };
    const output = await executePreparedCliRun(context);
    expect(order).toEqual(interruptible ? ["receipt", "source_reply"] : ["receipt"]);
    expect(output.text).toBe(interruptible ? "" : lateReply);
    expect(prepareCliRunTerminalReply(context, output).text).toBe("Die Hauptstadt ist Paris.");
  },
);

it.each([true, false])(
  "ends a turn whose reply was already sent when its yield is already pending (sent %s)",
  async (sentReply) => {
    const order: string[] = [];
    const { context } = await createExecution();
    context.mcpDeliveryCapture = true;
    context.params.messageChannel = "webchat";
    const narration = "I replied in the thread; the children will report back.";
    const execute: CliBackendExecute = async function* (execution) {
      execution.registerTurnInterrupt?.({
        interrupt: async (reason) => {
          order.push(reason);
        },
      });
      yield { type: "system", subtype: "init", session_id: "sdk-session" };
      const key = execution.env.OPENCLAW_MCP_CLI_CAPTURE_KEY;
      const loopback = (toolName: string, args: Record<string, unknown>, result: unknown) => {
        const request = mcp.markMcpLoopbackRequestStarted(key);
        const call = mcp.markMcpLoopbackToolCallStarted({
          requestCaptureHandle: request,
          toolName,
          args,
        });
        if (!call) {
          throw new Error("Missing production MCP capture");
        }
        mcp.recordMcpLoopbackToolCallResult({
          captureHandle: call,
          toolName,
          args,
          outcome: "completed",
          result,
        });
        mcp.markMcpLoopbackToolCallFinished(call);
        mcp.markMcpLoopbackRequestFinished(request);
      };
      if (sentReply) {
        const args = { action: "send", message: "Here is the chart.", final: false };
        yield message("assistant", [
          { type: "tool_use", id: "send-1", name: "mcp__openclaw__message", input: args },
        ]);
        const sent = {
          content: [{ type: "text", text: "sent" }],
          details: {
            deliveryStatus: "sent",
            sourceReplySink: "internal-ui",
            sourceReply: { text: "Here is the chart." },
            messageDelivery: {
              status: "settled",
              partialDelivery: false,
              createdThreadIds: [],
              sourceReplyDelivered: true,
            },
          },
        };
        loopback("message", args, sent);
        yield message("user", [{ type: "tool_result", tool_use_id: "send-1", ...sent }]);
      }
      yield message("assistant", [
        { type: "tool_use", id: "yield-1", name: "mcp__openclaw__sessions_yield", input: {} },
      ]);
      const pending = {
        content: [{ type: "text", text: '{"status":"already_pending"}' }],
        details: { status: "already_pending", pendingChildren: [] },
      };
      loopback("sessions_yield", {}, pending);
      yield message("user", [{ type: "tool_result", tool_use_id: "yield-1", ...pending }]);
      order.push("yield-receipt");
      yield message("assistant", [{ type: "text", text: narration }]);
      yield { ...SUCCESS_RESULT, result: narration };
    };
    context.executionTarget = { kind: "plugin", execute };
    const output = await executePreparedCliRun(context);
    // Without a delivered reply, already_pending keeps the turn so its answer stays the final.
    expect(order).toEqual(sentReply ? ["yield-receipt", "source_reply"] : ["yield-receipt"]);
    expect(output.text).toBe(sentReply ? "" : narration);
  },
);
