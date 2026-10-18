import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { postJson, withTransport } from "./crabline-transport.test-support.js";

describe("Crabline Slack transport", () => {
  it("keeps startup readiness and full runtime evidence for the same Slack provider", async () => {
    await withTransport("slack", async (transport, outputDir) => {
      const readArtifact = (relativePath: string) =>
        fs.readFile(path.join(outputDir, relativePath), "utf8");
      expect(transport.id).toBe("crabline");
      expect(transport.requiredPluginIds).toEqual(["slack"]);
      expect(transport.sendNativeCommand).toBeUndefined();
      expect(transport.waitForOutboundSequence).toBeUndefined();
      expect(
        transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" }).channels?.slack,
      ).toMatchObject({
        botToken: "xoxb-crabline-slack-token",
        enabled: true,
        mode: "http",
        signingSecret: "crabline-slack-signing-secret",
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
      const env = transport.createRuntimeEnvPatch?.() ?? {};
      const response = await fetch(`${env.SLACK_API_URL}users.info?user=U0123456789`, {
        headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      });
      await response.json();
      const recorderPath = "artifacts/crabline/slack-provider-server.jsonl";
      const beforeCapture = await readArtifact(recorderPath);
      expect(beforeCapture).toContain('"path":"/api/users.info"');

      const captured = await transport.captureArtifacts({ outputDir });
      const afterCapture = await readArtifact(recorderPath);
      expect(afterCapture.startsWith(beforeCapture)).toBe(true);
      const finalProbe = afterCapture.slice(beforeCapture.length).trim().split("\n");
      expect(finalProbe).toHaveLength(1);
      expect(JSON.parse(finalProbe[0]!)).toMatchObject({
        accepted: true,
        path: "/api/auth.test",
      });
      const readinessPath = captured.artifacts.find(
        (artifact) => artifact.kind === "channel-driver-smoke",
      )!.path;
      const readiness = JSON.parse(await readArtifact(readinessPath));
      const startupRecorder = await readArtifact(readiness.providerReadiness.result.recorderPath);
      expect(startupRecorder).toContain('"path":"/api/auth.test"');
      expect(startupRecorder).not.toContain('"path":"/api/users.info"');
      expect(captured.reportNotes.join("\n")).toContain(recorderPath);
    });
  });

  it("delivers signed Crabline Slack events to the Gateway before recording admitted inbound", async () => {
    await withTransport("slack", async (transport, outputDir) => {
      const requests: Array<{ path: string | undefined; body: unknown; signed: boolean }> = [];
      let rejectWebhook = false;
      let holdWebhook = false;
      const pendingWebhook = Promise.withResolvers<void>();
      const conversation = { id: "D12345678", kind: "direct" } as const;
      const stopped = "Crabline Slack inbound transport stopped";
      const send = (text: string, senderName?: string) =>
        transport.sendInbound({
          conversation,
          senderId: "U12345678",
          ...(senderName ? { senderName } : {}),
          text,
        });
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
          const inbound = await send("Slack baseline marker check.", "Alice");
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
          await expect(send("Rejected webhook")).rejects.toThrow(
            "Crabline Slack Gateway webhook failed with HTTP 503",
          );
          expect(requests).toHaveLength(2);
          expect(transport.state.getSnapshot().messages.map((message) => message.text)).toEqual([
            "Slack baseline marker check.",
          ]);

          const env = transport.createRuntimeEnvPatch?.() ?? {};
          expect(env.SLACK_API_URL).toBeTruthy();
          expect(env.SLACK_BOT_TOKEN).toBeTruthy();
          const outbound = { conversation, text: "assistant via fake slack" };
          await postJson(
            `${env.SLACK_API_URL}chat.postMessage`,
            { channel: conversation.id, text: outbound.text },
            "qa-lab-crabline-slack-transport-test",
            { headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } },
          );

          await expect(
            transport.waitForOutbound({
              conversation,
              textIncludes: outbound.text,
              timeoutMs: 1_000,
            }),
          ).resolves.toMatchObject(outbound);

          await expect(
            transport.state.waitFor({
              direction: "outbound",
              kind: "message-text",
              textIncludes: outbound.text,
              timeoutMs: 1_000,
            }),
          ).resolves.toMatchObject({
            ...outbound,
            direction: "outbound",
          });
          holdWebhook = true;
          const interrupted = expect(send("Interrupted webhook")).rejects.toThrow(stopped);
          await pendingWebhook.promise;
          await transport.cleanup?.();
          await interrupted;
          await expect(send("After shutdown")).rejects.toThrow(stopped);
          expect(requests).toHaveLength(3);
          expect(
            transport.state
              .getSnapshot()
              .messages.filter((message) => message.direction === "inbound"),
          ).toHaveLength(1);
        },
      );
    });
  });
});
