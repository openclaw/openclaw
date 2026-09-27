import { createHmac } from "node:crypto";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

const selection = {
  capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
  channel: "slack",
  channelDriver: "crabline",
  providerReadinessArtifactPath: "crabline-provider-readiness.json",
} as const;

describe("Crabline Slack transport", () => {
  it("configures OpenClaw's Slack plugin against a Crabline local provider server", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection,
        state: createQaBusState(),
      });

      try {
        expect(transport.id).toBe("crabline");
        expect(transport.requiredPluginIds).toEqual(["slack"]);
        expect(transport.sendNativeCommand).toBeUndefined();
        expect(transport.waitForOutboundSequence).toBeUndefined();
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            slack: {
              botToken: "xoxb-crabline-slack-token",
              enabled: true,
              mode: "http",
              signingSecret: "crabline-slack-signing-secret",
            },
          },
        });
        expect(transport.createRuntimeEnvPatch?.()).toMatchObject({
          SLACK_API_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/api\/$/u),
          SLACK_BOT_TOKEN: "xoxb-crabline-slack-token",
          SLACK_SIGNING_SECRET: "crabline-slack-signing-secret",
        });
        expect(transport.buildAgentDelivery({ target: "C1234567890" })).toMatchObject({
          channel: "slack",
          replyTo: "C1234567890",
          to: "C1234567890",
        });
      } finally {
        await transport.cleanupAfterGatewayStop?.();
      }
    });
  });

  it("delivers signed Crabline Slack events to the Gateway before recording admitted inbound", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection,
        state: createQaBusState(),
      });

      const requests: Array<{ path: string | undefined; body: unknown; signed: boolean }> = [];
      let rejectWebhook = false;
      let holdWebhook = false;
      const pendingWebhook = Promise.withResolvers<void>();
      try {
        await withServer(
          (request, response) => {
            void (async () => {
              let body = "";
              for await (const chunk of request) {
                body += String(chunk);
              }
              const timestamp = request.headers["x-slack-request-timestamp"];
              if (typeof timestamp !== "string") {
                response.writeHead(401).end();
                return;
              }
              const signature = `v0=${createHmac("sha256", "crabline-slack-signing-secret")
                .update(`v0:${timestamp}:${body}`)
                .digest("hex")}`;
              const signed =
                request.headers["x-slack-signature"] === signature &&
                Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
              requests.push({ path: request.url, body: JSON.parse(body), signed });
              if (holdWebhook) {
                pendingWebhook.resolve();
                return;
              }
              response.writeHead(!signed ? 401 : rejectWebhook ? 503 : 200);
              response.end();
            })().catch((error: unknown) =>
              response.destroy(error instanceof Error ? error : new Error(String(error))),
            );
          },
          async (baseUrl) => {
            await transport.prepareFlow?.({
              config: {},
              scenarioId: "slack-webhook",
              scenarioTitle: "Slack webhook",
              gateway: {
                baseUrl,
                tempRoot: outputDir,
                workspaceDir: outputDir,
                runtimeEnv: {},
                call: async () => ({}),
              },
              outputDir,
              timeoutMs: 1000,
              waitForConfigRestartSettle: async () => {},
            });
            const inbound = await transport.sendInbound({
              conversation: {
                id: "D12345678",
                kind: "direct",
              },
              senderId: "U12345678",
              senderName: "Alice",
              text: "Slack baseline marker check.",
            });
            expect(inbound.id).toMatch(/^\d+\.\d+$/u);
            expect(transport.state.readMessage({ messageId: inbound.id })).toEqual(inbound);
            expect(transport.state.getSnapshot().events).toContainEqual(
              expect.objectContaining({ kind: "inbound-message", message: inbound }),
            );
            expect(requests).toEqual([
              {
                path: "/slack/events",
                signed: true,
                body: expect.objectContaining({
                  type: "event_callback",
                  event_id: expect.any(String),
                  event: expect.objectContaining({
                    channel: "D12345678",
                    user: "U12345678",
                    text: "Slack baseline marker check.",
                    ts: inbound.id,
                  }),
                }),
              },
            ]);

            rejectWebhook = true;
            await expect(
              transport.sendInbound({
                conversation: { id: "D12345678", kind: "direct" },
                senderId: "U12345678",
                text: "Rejected webhook",
              }),
            ).rejects.toThrow("Crabline Slack Gateway webhook failed with HTTP 503");
            expect(requests).toHaveLength(2);
            expect(transport.state.getSnapshot().messages.map((message) => message.text)).toEqual([
              "Slack baseline marker check.",
            ]);

            const env = transport.createRuntimeEnvPatch?.() ?? {};
            expect(env.SLACK_API_URL).toBeTruthy();
            expect(env.SLACK_BOT_TOKEN).toBeTruthy();
            const { response, release } = await fetchWithSsrFGuard({
              url: `${env.SLACK_API_URL}chat.postMessage`,
              init: {
                body: JSON.stringify({
                  channel: "D12345678",
                  text: "assistant via fake slack",
                }),
                headers: {
                  authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
                  "content-type": "application/json",
                },
                method: "POST",
              },
              policy: { allowPrivateNetwork: true },
              auditContext: "qa-lab-crabline-slack-transport-test",
            });
            await release();
            expect(response.ok).toBe(true);

            await expect(
              transport.waitForOutbound({
                conversation: { id: "D12345678", kind: "direct" },
                textIncludes: "assistant via fake slack",
                timeoutMs: 1_000,
              }),
            ).resolves.toMatchObject({
              conversation: { id: "D12345678", kind: "direct" },
              text: "assistant via fake slack",
            });

            await expect(
              transport.state.waitFor({
                direction: "outbound",
                kind: "message-text",
                textIncludes: "assistant via fake slack",
                timeoutMs: 1_000,
              }),
            ).resolves.toMatchObject({
              conversation: {
                id: "D12345678",
                kind: "direct",
              },
              direction: "outbound",
              text: "assistant via fake slack",
            });
            holdWebhook = true;
            const interrupted = expect(
              transport.sendInbound({
                conversation: { id: "D12345678", kind: "direct" },
                senderId: "U12345678",
                text: "Interrupted webhook",
              }),
            ).rejects.toThrow("Crabline Slack inbound transport stopped");
            await pendingWebhook.promise;
            await transport.cleanup?.();
            await interrupted;
            await expect(
              transport.sendInbound({
                conversation: { id: "D12345678", kind: "direct" },
                senderId: "U12345678",
                text: "After shutdown",
              }),
            ).rejects.toThrow("Crabline Slack inbound transport stopped");
            expect(requests).toHaveLength(3);
            expect(
              transport.state
                .getSnapshot()
                .messages.filter((message) => message.direction === "inbound"),
            ).toHaveLength(1);
          },
        );
      } finally {
        await transport.cleanupAfterGatewayStop?.();
      }
    });
  });
});
