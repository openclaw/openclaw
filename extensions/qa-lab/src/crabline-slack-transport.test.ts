import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { expectDelivery, postJson, withTransport } from "./crabline-transport.test-support.js";

it("keeps readiness evidence and admits signed events through the transport lifecycle", async () => {
  await withTransport("slack", async (transport, outputDir) => {
    const readArtifact = (relativePath: string) =>
      fs.readFile(path.join(outputDir, relativePath), "utf8");
    expect(transport.requiredPluginIds).toEqual(["slack"]);
    expect(
      transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" }).channels?.slack,
    ).toMatchObject({
      botToken: "xoxb-crabline-slack-token",
      enabled: true,
      mode: "http",
      signingSecret: "crabline-slack-signing-secret",
    });
    const env = transport.createRuntimeEnvPatch?.() ?? {};
    expect(env).toMatchObject({
      SLACK_API_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/api\/$/u),
      SLACK_BOT_TOKEN: "xoxb-crabline-slack-token",
      SLACK_SIGNING_SECRET: "crabline-slack-signing-secret",
    });
    expectDelivery(transport, "slack", "C1234567890", "C1234567890");
    const providerResponse = await fetch(`${env.SLACK_API_URL}users.info?user=U0123456789`, {
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    await providerResponse.json();
    const recorderPath = "artifacts/crabline/slack-provider-server.jsonl";
    const beforeCapture = await readArtifact(recorderPath);
    expect(beforeCapture).toContain('"path":"/api/users.info"');

    const captured = await transport.captureArtifacts({ outputDir });
    const afterCapture = await readArtifact(recorderPath);
    expect(afterCapture.startsWith(beforeCapture)).toBe(true);
    expect(JSON.parse(afterCapture.slice(beforeCapture.length))).toMatchObject({
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
    const requests: Array<[path: string | undefined, signed: boolean, body: unknown]> = [];
    let rejectWebhook = false;
    let holdWebhook = false;
    const pendingWebhook = Promise.withResolvers<void>();
    const conversation = { id: "D12345678", kind: "direct" } as const;
    const nativeMessage = { channel: conversation.id, user: "U12345678", text: "inbound" };
    const stopped = "Crabline Slack inbound transport stopped";
    const send = (text: string) =>
      transport.sendInbound({
        conversation,
        senderId: nativeMessage.user,
        senderName: "Alice",
        text,
      });
    await withServer(
      (request, response) => {
        void (async () => {
          const body = await readText(request);
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
          requests.push([request.url, signed, JSON.parse(body)]);
          if (holdWebhook) {
            pendingWebhook.resolve();
            return;
          }
          response.writeHead(!signed ? 401 : rejectWebhook ? 503 : 200).end();
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
        const inbound = await send(nativeMessage.text);
        expect(inbound.id).toMatch(/^\d+\.\d+$/u);
        expect(transport.state.readMessage({ messageId: inbound.id })).toEqual(inbound);
        expect(transport.state.getSnapshot().events).toContainEqual(
          expect.objectContaining({ kind: "inbound-message", message: inbound }),
        );
        expect(requests).toMatchObject([
          [
            "/slack/events",
            true,
            {
              type: "event_callback",
              event_id: expect.any(String),
              event: { ...nativeMessage, ts: inbound.id },
            },
          ],
        ]);

        rejectWebhook = true;
        await expect(send("Rejected webhook")).rejects.toThrow(
          "Crabline Slack Gateway webhook failed with HTTP 503",
        );
        expect(requests).toHaveLength(2);
        expect(transport.state.getSnapshot().messages.map((message) => message.text)).toEqual([
          nativeMessage.text,
        ]);

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
        ).resolves.toMatchObject({ ...outbound, direction: "outbound" });

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
