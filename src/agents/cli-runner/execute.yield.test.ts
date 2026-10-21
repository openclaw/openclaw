import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as mcp from "../../gateway/mcp-http.loopback-runtime.js";
import { onAgentEventForRun } from "../../infra/agent-events.js";
import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
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

it.each([true, false])("settles yield after receipt (interruptible=%s)", async (interruptible) => {
  const order: string[] = [];
  const interrupt = vi.fn(async () => {
    order.push("interrupt");
  });
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
    const call = mcp.markMcpLoopbackToolCallStarted({
      requestCaptureHandle: request,
      toolName: "sessions_yield",
      args: {},
    });
    const yieldContext = mcp.resolveMcpLoopbackYieldContext(request);
    if (!call || !yieldContext) {
      throw new Error("Missing production MCP capture");
    }
    await yieldContext.onYield("Wait for children", "Research is running.");
    const result = { content: [{ type: "text", text: '{"status":"yielded"}' }] };
    mcp.recordMcpLoopbackToolCallResult({
      captureHandle: call,
      toolName: "sessions_yield",
      args: {},
      outcome: "completed",
      result,
    });
    mcp.markMcpLoopbackToolCallFinished(call);
    mcp.markMcpLoopbackRequestFinished(request);
    order.push("answered");
    const receipt = message("user", [{ type: "tool_result", tool_use_id: "yield-1", ...result }]);
    yield receipt;
    yield receipt;
    yield message("assistant", [{ type: "text", text: "Late duplicate reply" }]);
    yield { ...SUCCESS_RESULT, result: "Late duplicate reply" };
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
  expect(order).toEqual(interruptible ? ["answered", "interrupt"] : ["answered"]);
  expect(interrupt.mock.calls).toEqual(interruptible ? [["yield"]] : []);
  if (interruptible) {
    expect(assistantEvents).toEqual([]);
  }
  expect(context.params.onSuccessfulAuthBinding).toHaveBeenCalledOnce();
  expect(result.payloads).toEqual(interruptible ? undefined : [{ text: "Late duplicate reply" }]);
  expect(result.meta).toMatchObject({
    yielded: true,
    stopReason: "end_turn",
    livenessState: "paused",
    yieldAcknowledgment: "Research is running.",
    agentMeta: { sessionId: "sdk-session", cliSessionBinding: { sessionId: "sdk-session" } },
  });
});
