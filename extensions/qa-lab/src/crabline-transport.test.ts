// Qa Lab tests cover Crabline fake-provider transport integration behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { OPENCLAW_CRABLINE_MANIFEST_PATH } from "@openclaw/crabline";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

function createSelection() {
  return {
    capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
    channel: "telegram",
    channelDriver: "crabline",
    smokeArtifactPath: "crabline-fake-provider-smoke.json",
  } as const;
}

describe("crabline transport", () => {
  it("configures OpenClaw's Telegram plugin against a Crabline fake provider server", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection(),
        state: createQaBusState(),
      });

      try {
        expect(transport.id).toBe("crabline");
        expect(transport.requiredPluginIds).toEqual(["telegram"]);
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            telegram: {
              apiRoot: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
              botToken: "424242:crabline-telegram-token",
              dmPolicy: "open",
              enabled: true,
              groupPolicy: "open",
            },
          },
        });
        expect(transport.buildAgentDelivery({ target: "dm:alice" })).toEqual({
          channel: "telegram",
          to: "100001",
          replyChannel: "telegram",
          replyTo: "100001",
        });

        const manifest = JSON.parse(
          await fs.readFile(path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH), "utf8"),
        ) as {
          provider?: string;
        };
        expect(manifest.provider).toBe("telegram");
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("injects inbound messages through Crabline and mirrors Telegram sends into normalized state", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection(),
        state: createQaBusState(),
      });

      try {
        await transport.state.addInboundMessage({
          conversation: {
            id: "alice",
            kind: "direct",
          },
          senderId: "alice",
          senderName: "Alice",
          text: "DM baseline marker check.",
        });

        const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
        const telegram = config.channels?.telegram as
          | { apiRoot?: string; botToken?: string }
          | undefined;
        expect(telegram?.apiRoot).toBeTruthy();
        expect(telegram?.botToken).toBeTruthy();
        const { response, release } = await fetchWithSsrFGuard({
          url: `${telegram?.apiRoot}/bot${telegram?.botToken}/sendMessage`,
          init: {
            body: JSON.stringify({
              chat_id: "100001",
              text: "assistant via fake telegram",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-transport-test",
        });
        await release();
        expect(response.ok).toBe(true);

        await expect(
          transport.state.waitFor({
            direction: "outbound",
            kind: "message-text",
            textIncludes: "assistant via fake telegram",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: {
            id: "alice",
            kind: "direct",
          },
          direction: "outbound",
          text: "assistant via fake telegram",
        });

        await transport.state.reset();
        const delivery = transport.buildAgentDelivery({ target: "dm:qa-operator" });
        const { response: directResponse, release: directRelease } = await fetchWithSsrFGuard({
          url: `${telegram?.apiRoot}/bot${telegram?.botToken}/sendMessage`,
          init: {
            body: JSON.stringify({
              chat_id: delivery.to,
              text: "assistant after reset",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-transport-reset-test",
        });
        await directRelease();
        expect(directResponse.ok).toBe(true);

        await expect(
          transport.state.waitFor({
            direction: "outbound",
            kind: "message-text",
            textIncludes: "assistant after reset",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: {
            id: "qa-operator",
            kind: "direct",
          },
          direction: "outbound",
          text: "assistant after reset",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });
});
