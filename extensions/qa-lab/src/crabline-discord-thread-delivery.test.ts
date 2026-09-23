// Integration tests preserve provider-native Discord thread ids through QA Lab and final send routing.
import { discordPlugin } from "@openclaw/discord/channel-plugin-api.js";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";
import { startAgentRun } from "./suite-runtime-agent-process.js";

describe("QA Crabline Discord thread delivery", () => {
  it.each([
    { taskTracking: true, method: "agent", toField: "to", threadField: "threadId" },
    {
      taskTracking: false,
      method: "chat.send",
      toField: "originatingTo",
      threadField: "originatingThreadId",
    },
  ] as const)("routes symbolic threads natively through $method", async (testCase) => {
    await withTempDir("qa-crabline-discord-thread-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: {
          capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
          channel: "discord",
          channelDriver: "crabline",
          providerReadinessArtifactPath: "crabline-provider-readiness.json",
        },
        state: createQaBusState(),
      });
      const gatewayCall = vi.fn(async (_method: string, _payload: Record<string, unknown>) => ({
        runId: `run-${testCase.method}`,
      }));

      try {
        await startAgentRun({ gateway: { call: gatewayCall }, transport } as never, {
          sessionKey: `agent:qa:${testCase.method}`,
          message: "Discord thread delivery proof",
          to: "group:discord-crabline-primary",
          threadId: "discord-crabline-thread",
          taskTracking: testCase.taskTracking,
        });

        const call = gatewayCall.mock.calls[0];
        if (!call) {
          throw new Error("Gateway call was not recorded");
        }
        const [method, payload] = call;
        expect(method).toBe(testCase.method);
        const to = String(payload[testCase.toField]);
        const threadId = String(payload[testCase.threadField]);
        expect(to).toMatch(/^channel:\d{17,20}$/u);
        expect(threadId).toMatch(/^\d{17,20}$/u);

        const sendDiscord = vi.fn(async () => ({ messageId: `sent-${testCase.method}` }));
        await discordPlugin.outbound!.sendText!({
          cfg: {},
          to,
          threadId,
          text: "Discord thread delivery proof",
          silent: true,
          deps: { discord: sendDiscord },
        });
        expect(sendDiscord).toHaveBeenCalledWith(
          `channel:${threadId}`,
          "Discord thread delivery proof",
          expect.any(Object),
        );
      } finally {
        await transport.cleanupAfterGatewayStop?.();
      }
    });
  });
});
