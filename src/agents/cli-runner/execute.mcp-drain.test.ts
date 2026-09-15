import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  revokeMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";
import {
  destinations,
  discordMessage,
  useMcpMessageActions,
} from "../../gateway/mcp-http.message-actions.test-support.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { runPlugin, SUCCESS_RESULT } from "./execute-plugin.test-support.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";

vi.mock("../node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

describe("CLI message result drain", () => {
  const fixture = useMcpMessageActions("discord");

  it("retains a committed Gateway send result after normal CLI completion", async () => {
    const turn = await fixture.createTurn({ gatewaySend: true });
    const heldSend = fixture.holdNextSend();
    const context = buildPreparedCliRunContext({
      ...turn.runParams,
      provider: "claude-cli",
      backend: { command: "/bin/sh", args: [] },
    });
    context.params = { ...context.params, ...turn.runParams };
    context.preparedBackend.mcpClientGrantCapture = {
      transportToken: turn.capture.token,
      adoptProcessToken: (targetToken) => {
        transferMcpLoopbackClientGrant({
          sourceToken: turn.capture.token,
          targetToken,
          runtimeOwnerToken: turn.capture.runtimeOwnerToken,
        });
      },
      revokeProcessToken: () => {
        revokeMcpLoopbackClientGrant(turn.capture.token);
      },
      activate: (captureKey, assertCurrent) => {
        activateMcpLoopbackClientGrantCapture({ ...turn.capture, captureKey, assertCurrent });
      },
      deactivate: (captureKey) => {
        deactivateMcpLoopbackClientGrantCapture({ ...turn.capture, captureKey });
      },
    };
    const tracking = createCliToolTracking(context);
    const toolCallId = "accepted-gateway-send";
    const args = {
      action: "send",
      channel: "discord",
      target: `channel:${destinations.discord.current}`,
      message: "Preserve the accepted message.",
    };
    let pendingSend: ReturnType<typeof turn.call> | undefined;
    let nativeSignal: AbortSignal | undefined;
    let drain: Promise<void> | undefined;
    const recordRunError = vi.fn();
    try {
      await expect(
        runPlugin(
          context,
          async function* (execution) {
            nativeSignal = execution.abortSignal;
            tracking.handleCliToolUseStart({
              toolCallId,
              name: "mcp__openclaw__message",
              kind: "mcp_tool_use",
              args,
            });
            pendingSend = turn.call(args);
            void pendingSend.catch(() => undefined);
            await heldSend.entered();
            yield { ...SUCCESS_RESULT, session_id: turn.runParams.sessionId };
          },
          {
            sessionId: turn.runParams.sessionId,
            activeToolCount: () => (pendingSend ? 1 : 0),
            mcpCapture: {
              captureKey: turn.capture.captureKey,
              beginCapture: tracking.beginGatewayCapture,
            },
          },
        ),
      ).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
      expect(nativeSignal?.aborted).toBe(true);

      drain = tracking.finishDeliveryTracking({
        useManagedClaudeLiveSession: false,
        recordRunError,
      });
      heldSend.release();
      const response = await expectDefined(pendingSend, "accepted MCP message request");
      await drain;

      expect(response).toMatchObject({ result: { isError: false } });
      expect(JSON.stringify(response)).toContain(discordMessage);
      expect(tracking.resolveCliLoopbackTerminalOutcome(toolCallId)).toEqual({
        outcome: "completed",
      });
      const evidence = tracking.withExecutionEvidence({ text: "completed" });
      expect(evidence.didSendViaMessagingTool).toBe(true);
      expect(evidence.messagingToolSentTexts).toEqual([args.message]);
      expect(evidence.messagingToolSentTargets).toEqual([
        expect.objectContaining({ provider: "discord", text: args.message }),
      ]);
      expect(recordRunError).not.toHaveBeenCalled();
      expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      const gateway = expectDefined(turn.gatewayContext, "Gateway-owned send fixture");
      expect([...gateway.dedupe.values()]).toContainEqual(expect.objectContaining({ ok: true }));
    } finally {
      heldSend.release();
      await pendingSend?.catch(() => undefined);
      await drain;
      tracking.finalizeCapture(() => {});
    }
    expect(turn.isCurrent()).toBe(false);
  });
});
