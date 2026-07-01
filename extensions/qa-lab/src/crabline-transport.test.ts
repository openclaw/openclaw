// Qa Lab tests cover Crabline local-provider transport integration behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { OPENCLAW_CRABLINE_MANIFEST_PATH } from "@openclaw/crabline";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

function createSelection(channel: "slack" | "telegram" | "whatsapp" = "telegram") {
  return {
    capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
    channel,
    channelDriver: "crabline",
    smokeArtifactPath: "crabline-fake-provider-smoke.json",
  } as const;
}

describe("crabline transport", () => {
  it("configures OpenClaw's Telegram plugin against a Crabline local provider server", async () => {
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

  it("configures OpenClaw's Slack plugin against a Crabline local provider server", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("slack"),
        state: createQaBusState(),
      });

      try {
        expect(transport.id).toBe("crabline");
        expect(transport.requiredPluginIds).toEqual(["slack"]);
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

        const manifest = JSON.parse(
          await fs.readFile(path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH), "utf8"),
        ) as {
          provider?: string;
        };
        expect(manifest.provider).toBe("slack");
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("injects inbound messages through Crabline and mirrors Slack sends into normalized state", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("slack"),
        state: createQaBusState(),
      });

      try {
        await transport.state.addInboundMessage({
          conversation: {
            id: "D12345678",
            kind: "direct",
          },
          senderId: "U12345678",
          senderName: "Alice",
          text: "Slack baseline marker check.",
        });

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
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("configures OpenClaw's WhatsApp plugin against a Crabline Baileys WebSocket server", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("whatsapp"),
        state: createQaBusState(),
      });

      try {
        expect(transport.id).toBe("crabline");
        expect(transport.requiredPluginIds).toEqual(["whatsapp"]);
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            whatsapp: {
              allowFrom: ["*"],
              dmPolicy: "open",
              enabled: true,
              groupAllowFrom: ["*"],
              groupPolicy: "open",
            },
          },
        });
        expect(transport.buildAgentDelivery({ target: "15551234567@s.whatsapp.net" })).toEqual({
          channel: "whatsapp",
          to: "15551234567@s.whatsapp.net",
          replyChannel: "whatsapp",
          replyTo: "15551234567@s.whatsapp.net",
        });
        const env = transport.createRuntimeEnvPatch?.() ?? {};
        expect(env).toMatchObject({
          CRABLINE_WHATSAPP_ADMIN_TOKEN: expect.any(String),
          CRABLINE_WHATSAPP_RECORDER_PATH: expect.stringMatching(/whatsapp-fake-provider\.jsonl$/u),
          CRABLINE_WHATSAPP_SELF_JID: "15550000000@s.whatsapp.net",
          OPENCLAW_WHATSAPP_WEB_SOCKET_URL: expect.stringMatching(
            /^ws:\/\/127\.0\.0\.1:\d+\/crabline\/whatsapp\/ws\/chat\?access_token=/u,
          ),
        });
        expect(env.CRABLINE_WHATSAPP_ACCESS_TOKEN).toBeUndefined();
        expect(env.CRABLINE_WHATSAPP_API_ROOT).toBeUndefined();

        const manifest = JSON.parse(
          await fs.readFile(path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH), "utf8"),
        ) as {
          provider?: string;
        };
        expect(manifest.provider).toBe("whatsapp");
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("injects WhatsApp inbound messages through Crabline into normalized state", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("whatsapp"),
        state: createQaBusState(),
      });

      try {
        const message = await transport.state.addInboundMessage({
          conversation: {
            id: "15551234567@s.whatsapp.net",
            kind: "direct",
          },
          senderId: "15557654321@s.whatsapp.net",
          senderName: "Alice",
          text: "WhatsApp baseline marker check.",
        });
        expect(message).toMatchObject({
          conversation: {
            id: "15551234567@s.whatsapp.net",
            kind: "direct",
          },
          direction: "inbound",
          senderId: "15557654321@s.whatsapp.net",
          text: "WhatsApp baseline marker check.",
        });
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
