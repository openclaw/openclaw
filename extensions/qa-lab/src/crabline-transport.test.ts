// Qa Lab tests cover Crabline local-provider transport integration behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  type OpenClawCrablineChannelDriverSelection,
} from "@openclaw/crabline";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

function createSelection(channel: OpenClawCrablineChannelDriverSelection["channel"] = "telegram") {
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

  it("injects Telegram native commands through the shared transport adapter", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection(),
        state: createQaBusState(),
      });

      try {
        expect(transport.sendNativeCommand).toBeTypeOf("function");
        await transport.sendNativeCommand?.({
          command: "stop",
          conversation: { id: "alice", kind: "direct" },
          senderId: "alice",
          senderName: "Alice",
        });

        const manifest = JSON.parse(
          await fs.readFile(path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH), "utf8"),
        ) as {
          botToken: string;
          endpoints: { apiRoot: string };
        };
        const response = await fetch(
          `${manifest.endpoints.apiRoot}/bot${manifest.botToken}/getUpdates`,
        );
        await expect(response.json()).resolves.toMatchObject({
          result: [
            {
              message: {
                entities: [{ length: 5, offset: 0, type: "bot_command" }],
                text: "/stop",
              },
            },
          ],
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("observes Telegram preview edits through the shared transport adapter", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection(),
        state: createQaBusState(),
      });

      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH), "utf8"),
        ) as {
          botToken: string;
          endpoints: { apiRoot: string };
        };
        const postTelegram = async (method: string, body: Record<string, unknown>) => {
          const response = await fetch(
            `${manifest.endpoints.apiRoot}/bot${manifest.botToken}/${method}`,
            {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
              method: "POST",
            },
          );
          expect(response.ok).toBe(true);
          return (await response.json()) as { result: { message_id: number } };
        };
        const sent = await postTelegram("sendMessage", {
          chat_id: "-1001234567890",
          message_thread_id: 42,
          text: "preview text",
        });
        expect(transport.state.searchMessages({ query: "preview text" })).toEqual([
          expect.objectContaining({ text: "preview text" }),
        ]);
        await postTelegram("editMessageText", {
          chat_id: "-1001234567890",
          message_id: sent.result.message_id,
          text: "final marker",
        });

        expect(transport.waitForOutboundSequence).toBeTypeOf("function");
        await expect(
          transport.waitForOutboundSequence!({
            conversationId: "-1001234567890",
            finalSettleMs: 0,
            finalTextIncludes: "final marker",
            minimumPreviewEvents: 1,
            threadId: "42",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          events: [{ kind: "sent" }, { kind: "edited" }],
          final: { text: "final marker", threadId: "42" },
        });
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
        await transport.sendInbound({
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

  it("binds Signal config and normalizes transport targets", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("signal"),
        state: createQaBusState(),
      });

      try {
        expect(transport.requiredPluginIds).toEqual(["signal"]);
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            signal: {
              account: "+15550000000",
              apiMode: "native",
              autoStart: false,
              enabled: true,
              httpUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
            },
          },
        });
        expect(transport.createRuntimeEnvPatch?.()).toEqual({});
        expect(transport.buildAgentDelivery({ target: "dm:alice" })).toMatchObject({
          channel: "signal",
          replyChannel: "signal",
          replyTo: expect.stringMatching(/^\+1555\d{7}$/u),
          to: expect.stringMatching(/^\+1555\d{7}$/u),
        });

        await expect(
          transport.state.addInboundMessage({
            conversation: { id: "alice", kind: "direct" },
            senderId: "alice",
            senderName: "Alice",
            text: "Signal baseline marker check.",
          }),
        ).resolves.toMatchObject({
          conversation: { id: "alice", kind: "direct" },
          direction: "inbound",
          senderId: "alice",
          text: "Signal baseline marker check.",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("normalizes native Signal JSON-RPC sends into outbound state", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("signal"),
        state: createQaBusState(),
      });

      try {
        const delivery = transport.buildAgentDelivery({ target: "dm:alice" });
        const manifest = JSON.parse(
          await fs.readFile(path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH), "utf8"),
        ) as {
          endpoints: { rpcUrl: string };
        };
        const { response, release } = await fetchWithSsrFGuard({
          url: manifest.endpoints.rpcUrl,
          init: {
            body: JSON.stringify({
              id: "qa-signal-send",
              jsonrpc: "2.0",
              method: "send",
              params: {
                message: "assistant via fake signal",
                recipient: [delivery.to],
              },
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-signal-transport-test",
        });
        await release();
        expect(response.ok).toBe(true);

        await expect(
          transport.waitForOutbound({
            conversation: { id: "alice", kind: "direct" },
            textIncludes: "assistant via fake signal",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: "alice", kind: "direct" },
          text: "assistant via fake signal",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("binds Mattermost config and normalizes transport targets", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("mattermost"),
        state: createQaBusState(),
      });

      try {
        expect(transport.requiredPluginIds).toEqual(["mattermost"]);
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            mattermost: {
              baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
              botToken: "crabline-mattermost-token",
              enabled: true,
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          },
        });
        expect(transport.createRuntimeEnvPatch?.()).toMatchObject({
          MATTERMOST_BOT_TOKEN: "crabline-mattermost-token",
          MATTERMOST_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
        });
        expect(transport.buildAgentDelivery({ target: "group:qa-channel" })).toMatchObject({
          channel: "mattermost",
          replyChannel: "mattermost",
          replyTo: expect.stringMatching(/^channel:[a-z0-9]{26}$/u),
          to: expect.stringMatching(/^channel:[a-z0-9]{26}$/u),
        });

        await expect(
          transport.state.addInboundMessage({
            conversation: { id: "qa-channel", kind: "group" },
            senderId: "alice",
            senderName: "Alice",
            text: "Mattermost baseline marker check.",
          }),
        ).resolves.toMatchObject({
          conversation: { id: "qa-channel", kind: "group" },
          direction: "inbound",
          senderId: "alice",
          text: "Mattermost baseline marker check.",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("normalizes native Mattermost post creation into outbound state", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("mattermost"),
        state: createQaBusState(),
      });

      try {
        await transport.state.addInboundMessage({
          conversation: { id: "qa-channel", kind: "group" },
          senderId: "alice",
          senderName: "Alice",
          text: "Mattermost baseline marker check.",
        });
        const delivery = transport.buildAgentDelivery({ target: "group:qa-channel" });
        const manifest = JSON.parse(
          await fs.readFile(path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH), "utf8"),
        ) as {
          botToken: string;
          endpoints: { apiRoot: string };
        };
        const { response, release } = await fetchWithSsrFGuard({
          url: `${manifest.endpoints.apiRoot}/posts`,
          init: {
            body: JSON.stringify({
              channel_id: delivery.to.replace(/^channel:/u, ""),
              message: "assistant via fake mattermost",
            }),
            headers: {
              authorization: `Bearer ${manifest.botToken}`,
              "content-type": "application/json",
            },
            method: "POST",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-mattermost-transport-test",
        });
        await release();
        expect(response.ok).toBe(true);

        await expect(
          transport.waitForOutbound({
            conversation: { id: "qa-channel", kind: "group" },
            textIncludes: "assistant via fake mattermost",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: "qa-channel", kind: "group" },
          text: "assistant via fake mattermost",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("binds Matrix config and normalizes transport targets", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("matrix"),
        state: createQaBusState(),
      });

      try {
        expect(transport.requiredPluginIds).toEqual(["matrix"]);
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            matrix: {
              accessToken: expect.any(String),
              enabled: true,
              encryption: false,
              homeserver: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
              network: { dangerouslyAllowPrivateNetwork: true },
              userId: "@openclaw:matrix.test",
            },
          },
        });
        expect(transport.createRuntimeEnvPatch?.()).toMatchObject({
          MATRIX_ACCESS_TOKEN: expect.any(String),
          MATRIX_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
          MATRIX_USER_ID: "@openclaw:matrix.test",
        });

        const roomId = "!qa:matrix.test";
        expect(transport.buildAgentDelivery({ target: `group:${roomId}` })).toEqual({
          channel: "matrix",
          replyChannel: "matrix",
          replyTo: `room:${roomId}`,
          to: `room:${roomId}`,
        });
        await expect(
          transport.state.addInboundMessage({
            conversation: { id: roomId, kind: "group" },
            senderId: "@alice:matrix.test",
            senderName: "Alice",
            text: "Matrix baseline marker check.",
          }),
        ).resolves.toMatchObject({
          conversation: { id: roomId, kind: "group" },
          direction: "inbound",
          senderId: "@alice:matrix.test",
          text: "Matrix baseline marker check.",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("normalizes native Matrix room message sends into outbound state", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("matrix"),
        state: createQaBusState(),
      });

      try {
        const roomId = "!qa:matrix.test";
        await transport.state.addInboundMessage({
          conversation: { id: roomId, kind: "group" },
          senderId: "@alice:matrix.test",
          senderName: "Alice",
          text: "Matrix baseline marker check.",
        });
        const delivery = transport.buildAgentDelivery({ target: `group:${roomId}` });
        const providerRoomId = delivery.to.replace(/^room:/u, "");
        const manifest = JSON.parse(
          await fs.readFile(path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH), "utf8"),
        ) as {
          accessToken: string;
          endpoints: { clientApiRoot: string };
        };
        const { response, release } = await fetchWithSsrFGuard({
          url: `${manifest.endpoints.clientApiRoot}/rooms/${encodeURIComponent(providerRoomId)}/send/m.room.message/qa-matrix-send`,
          init: {
            body: JSON.stringify({ body: "assistant via fake matrix", msgtype: "m.text" }),
            headers: {
              authorization: `Bearer ${manifest.accessToken}`,
              "content-type": "application/json",
            },
            method: "PUT",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-matrix-transport-test",
        });
        await release();
        expect(response.ok).toBe(true);

        await expect(
          transport.waitForOutbound({
            conversation: { id: roomId, kind: "group" },
            textIncludes: "assistant via fake matrix",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: roomId, kind: "group" },
          text: "assistant via fake matrix",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("configures Zalo and normalizes native message sends", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("zalo"),
        state: createQaBusState(),
      });

      try {
        expect(transport.requiredPluginIds).toEqual(["zalo"]);
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            zalo: {
              allowFrom: ["*"],
              botToken: "crabline-zalo-bot-token",
              dmPolicy: "open",
              enabled: true,
              groupAllowFrom: ["*"],
              groupPolicy: "open",
            },
          },
        });
        expect(transport.createRuntimeEnvPatch?.()).toMatchObject({
          ZALO_API_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
          ZALO_BOT_TOKEN: "crabline-zalo-bot-token",
        });

        await transport.state.addInboundMessage({
          conversation: { id: "qa-group", kind: "group" },
          senderId: "alice",
          senderName: "Alice",
          text: "Zalo baseline marker check.",
        });
        const delivery = transport.buildAgentDelivery({ target: "group:qa-group" });
        expect(delivery).toEqual({
          channel: "zalo",
          replyChannel: "zalo",
          replyTo: "qa-group",
          to: "qa-group",
        });

        const manifest = JSON.parse(
          await fs.readFile(path.join(outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH), "utf8"),
        ) as {
          botToken: string;
          endpoints: { apiRoot: string };
        };
        const { response, release } = await fetchWithSsrFGuard({
          url: `${manifest.endpoints.apiRoot}/bot${manifest.botToken}/sendMessage`,
          init: {
            body: JSON.stringify({
              chat_id: delivery.to,
              text: "assistant via fake zalo",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-zalo-transport-test",
        });
        await release();
        expect(response.ok).toBe(true);

        await expect(
          transport.waitForOutbound({
            conversation: { id: "qa-group", kind: "group" },
            textIncludes: "assistant via fake zalo",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: "qa-group", kind: "group" },
          text: "assistant via fake zalo",
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
