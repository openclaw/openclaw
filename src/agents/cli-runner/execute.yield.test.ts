import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  markMcpLoopbackRequestFinished,
  markMcpLoopbackRequestStarted,
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
  resolveMcpLoopbackYieldContext,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { onAgentEventForRun } from "../../infra/agent-events.js";
import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
import { buildCliRunResult } from "./cli-run-settlement.js";
import { closePluginTestAdmissions, createExecution } from "./execute-plugin.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import { prepareCliRunTerminalReply } from "./terminal-reply.js";

afterEach(closePluginTestAdmissions);

it.each([true, false])(
  "settles yield after the tool result (interruptible=%s)",
  async (interruptible) => {
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
    const onSuccessfulAuthBinding = vi.fn();
    context.params.onSuccessfulAuthBinding = onSuccessfulAuthBinding;
    const execute: CliBackendExecute = async function* (execution) {
      if (interruptible) {
        execution.registerTurnInterrupt?.({ interrupt });
      }
      yield { type: "system", subtype: "init", session_id: "sdk-session" };
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "yield-1", name: "mcp__openclaw__sessions_yield", input: {} },
          ],
        },
      };
      const request = markMcpLoopbackRequestStarted(execution.env.OPENCLAW_MCP_CLI_CAPTURE_KEY);
      const call = markMcpLoopbackToolCallStarted({
        requestCaptureHandle: request,
        toolName: "sessions_yield",
        args: {},
      });
      const yieldContext = resolveMcpLoopbackYieldContext(request);
      if (!call || !yieldContext) {
        throw new Error("Missing production MCP capture");
      }
      await yieldContext.onYield("Wait for children", "Research is running.");
      const result = { content: [{ type: "text", text: '{"status":"yielded"}' }] };
      recordMcpLoopbackToolCallResult({
        captureHandle: call,
        toolName: "sessions_yield",
        args: {},
        outcome: "completed",
        result,
      });
      markMcpLoopbackToolCallFinished(call);
      markMcpLoopbackRequestFinished(request);
      order.push("answered");
      const receipt = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "yield-1", ...result }],
        },
      };
      yield receipt;
      yield receipt;
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Late duplicate reply" }] },
      };
      yield {
        type: "result",
        subtype: "success",
        result: "Late duplicate reply",
        session_id: "sdk-session",
      };
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
      bindingFlushOk: true,
      usedHistoryPrompt: false,
      userTurnHandled: true,
      sessionBindingDisabled: false,
      preparedContextAgentMeta: {},
    });
    if (interruptible) {
      expect(order).toEqual(["answered", "interrupt"]);
      expect(interrupt).toHaveBeenCalledExactlyOnceWith("yield");
      expect(assistantEvents).toEqual([]);
      expect(result.payloads).toBeUndefined();
    } else {
      expect(order).toEqual(["answered"]);
      expect(interrupt).not.toHaveBeenCalled();
      expect(result.payloads).toEqual([{ text: "Late duplicate reply" }]);
    }
    expect(onSuccessfulAuthBinding).toHaveBeenCalledOnce();
    expect(result.meta).toMatchObject({
      yielded: true,
      stopReason: "end_turn",
      livenessState: "paused",
      yieldAcknowledgment: "Research is running.",
      agentMeta: { sessionId: "sdk-session", cliSessionBinding: { sessionId: "sdk-session" } },
    });
  },
);
