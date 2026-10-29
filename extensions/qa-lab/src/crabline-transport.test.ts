// Qa Lab tests cover Crabline channel-driver integration with local provider servers.
import fs from "node:fs/promises";
import path from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";
import {
  createSelection,
  expectDelivery,
  expectInbound,
  expectOutbound,
  postJson as post,
  requireString,
  telegramApi,
  withTransport,
} from "./crabline-transport.test-support.js";

describe("crabline transport", () => {
  it("configures OpenClaw's Telegram plugin against a Crabline local provider server", async () => {
    await withTransport("telegram", async (transport, outputDir) => {
      expect(transport.id).toBe("crabline");
      expect("cleanup" in transport).toBe(false);
      expect("cleanupAfterGatewayStop" in transport).toBe(true);
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
      const delivery = transport.buildAgentDelivery({ target: "dm:alice" });
      expect(delivery).toMatchObject({
        channel: "telegram",
        replyChannel: "telegram",
        replyTo: expect.stringMatching(/^[1-9]\d+$/u),
        to: expect.stringMatching(/^[1-9]\d+$/u),
      });
      expect(delivery.replyTo).toBe(delivery.to);
      expect(transport.buildAgentDelivery({ target: "dm:alice", threadId: "42" })).toMatchObject({
        threadId: "42",
      });
      expect(transport.buildAgentDelivery({ target: "-1001234567890" })).toMatchObject({
        channel: "telegram",
        replyTo: "-1001234567890",
        to: "-1001234567890",
      });

      await expect(
        fs.access(path.join(outputDir, "crabline-provider-server.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        transport.sendInbound({
          conversation: { id: "-1001234567890", kind: "group" },
          senderId: "100001",
          senderName: "Alice",
          text: "Telegram baseline marker check.",
        }),
      ).resolves.toMatchObject({
        id: expect.stringMatching(/^\d+$/u),
        text: "Telegram baseline marker check.",
      });
    });
  });

  it("configures distinct Telegram actors for canonical sender allowlist flows", async () => {
    await withTransport(
      "telegram",
      async (transport) => {
        const gatewayConfig = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
        const telegramConfig = gatewayConfig.channels?.telegram;
        expect(telegramConfig).toMatchObject({
          replyToMode: "off",
          allowFrom: [expect.stringMatching(/^[1-9]\d+$/u)],
          groupAllowFrom: [expect.stringMatching(/^[1-9]\d+$/u)],
          groupPolicy: "allowlist",
        });
        const allowedDriverId = Number(telegramConfig?.allowFrom?.[0]);
        await transport.state.addInboundMessage({
          conversation: { id: "qa-routing-ordering", kind: "group" },
          senderId: "observer",
          text: "observer",
        });
        await transport.state.addInboundMessage({
          conversation: { id: "qa-routing-ordering", kind: "group" },
          senderId: "driver",
          text: "driver",
        });

        const { url: apiUrl } = telegramApi(transport);
        const response = await fetch(`${apiUrl}/getUpdates`);
        const payload = (await response.json()) as {
          result?: Array<{ message?: { from?: { id?: number }; text?: string } }>;
        };
        const senderIds = payload.result?.map((update) => update.message?.from?.id);
        expect(senderIds?.[0]).not.toBe(allowedDriverId);
        expect(senderIds?.[1]).toBe(allowedDriverId);
      },
      { requireGroupMention: true, senderAllowlist: ["driver"], topLevelReplies: true },
    );
  });

  it("rejects canonical sender-policy flows on non-Telegram Crabline bridges", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      await expect(
        createQaCrablineTransportAdapter({
          outputDir,
          transportPolicy: { senderAllowlist: ["driver"] },
          selection: createSelection("matrix"),
          state: createQaBusState(),
        }),
      ).rejects.toThrow("Crabline matrix does not support the requested group transport policy");
    });
  });

  it("injects Telegram native commands through the shared transport adapter", async () => {
    await withTransport("telegram", async (transport) => {
      expect(transport.sendNativeCommand).toBeTypeOf("function");
      await transport.sendNativeCommand?.({
        command: "stop",
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        senderName: "Alice",
      });
      await transport.sendInbound({
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        senderName: "Alice",
        text: "/status",
        nativeCommand: { name: "status" },
      });

      const { url: apiUrl } = telegramApi(transport);
      const response = await fetch(`${apiUrl}/getUpdates`);
      await expect(response.json()).resolves.toMatchObject({
        result: [
          {
            message: {
              entities: [{ length: 5, offset: 0, type: "bot_command" }],
              text: "/stop",
            },
          },
          {
            message: {
              entities: [{ length: 7, offset: 0, type: "bot_command" }],
              text: "/status",
            },
          },
        ],
      });
    });
  });

  it("configures OpenClaw's WhatsApp plugin against a Crabline Baileys WebSocket server", async () => {
    await withTransport("whatsapp", async (transport) => {
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
      expectDelivery(
        transport,
        "whatsapp",
        "15551234567@s.whatsapp.net",
        "15551234567@s.whatsapp.net",
      );
      const env = transport.createRuntimeEnvPatch?.() ?? {};
      expect(env).toMatchObject({
        CRABLINE_WHATSAPP_ADMIN_TOKEN: expect.any(String),
        CRABLINE_WHATSAPP_RECORDER_PATH: expect.stringMatching(/whatsapp-provider-server\.jsonl$/u),
        CRABLINE_WHATSAPP_SELF_JID: "15550000000@s.whatsapp.net",
        OPENCLAW_WHATSAPP_WEB_SOCKET_URL: expect.stringMatching(
          /^ws:\/\/127\.0\.0\.1:\d+\/ws\/chat\?access_token=/u,
        ),
      });
      expect(env.CRABLINE_WHATSAPP_ACCESS_TOKEN).toBeUndefined();
      expect(env.CRABLINE_WHATSAPP_API_ROOT).toBeUndefined();
    });
  });

  it("injects WhatsApp inbound messages through Crabline into normalized state", async () => {
    await withTransport("whatsapp", async (transport) => {
      await expectInbound(
        transport,
        { id: "15557654321@s.whatsapp.net", kind: "direct" },
        "15557654321@s.whatsapp.net",
        "WhatsApp baseline marker check.",
      );
    });
  });

  it("binds Signal config and normalizes transport targets", async () => {
    await withTransport("signal", async (transport) => {
      expect(transport.requiredPluginIds).toEqual(["signal"]);
      const gatewayConfig = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
      expect(gatewayConfig).toMatchObject({
        channels: {
          signal: {
            account: "+15550000000",
            enabled: true,
            transport: {
              kind: "external-native",
              url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
            },
          },
        },
      });
      expect(gatewayConfig.channels?.signal).not.toHaveProperty("apiMode");
      expect(gatewayConfig.channels?.signal).not.toHaveProperty("autoStart");
      expect(gatewayConfig.channels?.signal).not.toHaveProperty("httpUrl");
      expect(transport.createRuntimeEnvPatch?.()).toEqual({});
      const delivery = transport.buildAgentDelivery({ target: "dm:alice" });
      expectDelivery(
        transport,
        "signal",
        "dm:alice",
        expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
      );
      expect(delivery.replyTo).toBe(delivery.to);
      await expectInbound(
        transport,
        { id: "alice", kind: "direct" },
        "alice",
        "Signal baseline marker check.",
      );
    });
  });

  it("normalizes native Signal JSON-RPC sends into outbound state", async () => {
    await withTransport("signal", async (transport) => {
      const delivery = transport.buildAgentDelivery({ target: "dm:alice" });
      const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
      const signal = config.channels?.signal as { transport?: { url?: string } } | undefined;
      const signalBaseUrl = requireString(signal?.transport?.url, "Signal HTTP URL");
      await post(
        `${signalBaseUrl}/api/v1/rpc`,
        {
          id: "qa-signal-send",
          jsonrpc: "2.0",
          method: "send",
          params: {
            message: "assistant via fake signal",
            recipient: [delivery.to],
          },
        },
        "qa-lab-crabline-signal-transport-test",
      );

      await expectOutbound(transport, { id: "alice", kind: "direct" }, "assistant via fake signal");
    });
  });

  it("binds Mattermost config and normalizes transport targets", async () => {
    await withTransport("mattermost", async (transport) => {
      expect(transport.requiredPluginIds).toEqual(["mattermost"]);
      const mattermostGatewayConfig = transport.createGatewayConfig({
        baseUrl: "http://127.0.0.1:1",
      }) as { channels?: { mattermost?: Record<string, unknown> } };
      expect(mattermostGatewayConfig).toMatchObject({
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
      expectDelivery(
        transport,
        "mattermost",
        "group:qa-channel",
        expect.stringMatching(/^channel:[a-z0-9]{26}$/u),
      );
      expect(
        transport.buildAgentDelivery({ target: "group:qa-channel", threadId: "post-root" }),
      ).toMatchObject({
        channel: "mattermost",
        threadId: expect.stringMatching(/^[a-z0-9]{26}$/u),
      });
      expect(mattermostGatewayConfig.channels?.mattermost?.streaming).toEqual({ mode: "off" });

      await expectInbound(
        transport,
        { id: "qa-channel", kind: "group" },
        "alice",
        "Mattermost baseline marker check.",
      );
    });
  });

  it("correlates Mattermost's authoritative inbound channel with symbolic QA state", async () => {
    await withTransport("mattermost", async (transport) => {
      await transport.state.addInboundMessage({
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        senderName: "Alice",
        text: "Mattermost baseline marker check.",
      });
      const env = transport.createRuntimeEnvPatch?.() ?? {};
      const mattermostUrl = requireString(env.MATTERMOST_URL, "Mattermost URL");
      const botToken = requireString(env.MATTERMOST_BOT_TOKEN, "Mattermost bot token");
      const mattermostRequest = async <T>(apiPath: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${botToken}`);
        headers.set("content-type", "application/json");
        const { response, release } = await fetchWithSsrFGuard({
          url: `${mattermostUrl}/api/v4${apiPath}`,
          init: {
            ...init,
            headers,
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-mattermost-transport-test",
        });
        try {
          expect(response.ok).toBe(true);
          return (await response.json()) as T;
        } finally {
          await release();
        }
      };
      const bot = await mattermostRequest<{ id: string }>("/users/me");
      const alice = await mattermostRequest<{ id: string }>("/users/username/alice");
      const directChannel = await mattermostRequest<{ id: string }>("/channels/direct", {
        body: JSON.stringify([bot.id, alice.id]),
        method: "POST",
      });
      const outboundPost = await mattermostRequest<{ channel_id: string }>("/posts", {
        body: JSON.stringify({
          channel_id: directChannel.id,
          message: "assistant via fake mattermost",
        }),
        method: "POST",
      });
      expect(outboundPost.channel_id).toBe(directChannel.id);

      await expectOutbound(
        transport,
        { id: "alice", kind: "direct" },
        "assistant via fake mattermost",
      );
    });
  });

  it("binds Matrix config and normalizes transport targets", async () => {
    await withTransport("matrix", async (transport) => {
      expect(transport.requiredPluginIds).toEqual(["matrix"]);
      const matrixGatewayConfig = transport.createGatewayConfig({
        baseUrl: "http://127.0.0.1:1",
      }) as { channels?: { matrix?: Record<string, unknown> } };
      expect(matrixGatewayConfig).toMatchObject({
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
      expect(matrixGatewayConfig.channels?.matrix?.streaming).toEqual({
        mode: "off",
        block: { enabled: false },
      });
      expect(matrixGatewayConfig.channels?.matrix?.blockStreaming).toBeUndefined();
      expect(transport.createRuntimeEnvPatch?.()).toMatchObject({
        MATRIX_ACCESS_TOKEN: expect.any(String),
        MATRIX_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
        MATRIX_USER_ID: "@openclaw:matrix.test",
      });

      const roomId = "main";
      expectDelivery(
        transport,
        "matrix",
        `group:${roomId}`,
        expect.stringMatching(/^room:![a-f0-9]{16}:matrix-qa\.test$/u),
      );
      for (const target of ["!qa:matrix.test", "matrix:room:!qa:matrix.test"]) {
        expectDelivery(transport, "matrix", target, "room:!qa:matrix.test");
      }
      expect(
        transport.buildAgentDelivery({ target: "group:main", threadId: "$event:matrix.test" }),
      ).toMatchObject({
        channel: "matrix",
        threadId: "$event:matrix.test",
      });
      expect(() => transport.buildAgentDelivery({ target: "group:" })).toThrow(
        "invalid qa-channel group target",
      );
      expect(() =>
        transport.buildAgentDelivery({ target: "thread:main/$event:matrix.test" }),
      ).toThrow("Matrix thread targets require OpenClaw QA thread forwarding");
      await expect(
        transport.state.addInboundMessage({
          conversation: { id: "  ", kind: "group" },
          senderId: "driver",
          senderName: "Alice",
          text: "Matrix invalid blank room.",
        }),
      ).rejects.toThrow("Matrix QA conversation id must be non-empty");
      await expectInbound(
        transport,
        { id: roomId, kind: "group" },
        "driver",
        "Matrix baseline marker check.",
        { id: expect.stringMatching(/^\$[A-Za-z0-9_-]{43}$/u) },
      );
    });
  });

  it("normalizes native Matrix room message sends into outbound state", async () => {
    await withTransport("matrix", async (transport) => {
      const roomId = "main";
      await transport.state.addInboundMessage({
        conversation: { id: roomId, kind: "group" },
        senderId: "driver",
        senderName: "Alice",
        text: "Provision Matrix room.",
      });
      await transport.state.reset();
      const delivery = transport.buildAgentDelivery({ target: `group:${roomId}` });
      const providerRoomId = delivery.to.replace(/^room:/u, "");
      const env = transport.createRuntimeEnvPatch?.() ?? {};
      const matrixBaseUrl = requireString(env.MATRIX_BASE_URL, "Matrix base URL");
      const accessToken = requireString(env.MATRIX_ACCESS_TOKEN, "Matrix access token");
      await post(
        `${matrixBaseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(providerRoomId)}/send/m.room.message/qa-matrix-send`,
        { body: "assistant via fake matrix", msgtype: "m.text" },
        "qa-lab-crabline-matrix-transport-test",
        { method: "PUT", headers: { authorization: `Bearer ${accessToken}` } },
      );

      await expectOutbound(transport, { id: roomId, kind: "group" }, "assistant via fake matrix");
    });
  });

  it("configures Zalo and normalizes native message sends", async () => {
    await withTransport("zalo", async (transport) => {
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
      expectDelivery(transport, "zalo", "group:qa-group", "qa-group");

      const env = transport.createRuntimeEnvPatch?.() ?? {};
      const zaloApiUrl = requireString(env.ZALO_API_URL, "Zalo API URL");
      const botToken = requireString(env.ZALO_BOT_TOKEN, "Zalo bot token");
      await post(
        `${zaloApiUrl}/bot${botToken}/sendMessage`,
        { chat_id: delivery.to, text: "assistant via fake zalo" },
        "qa-lab-crabline-zalo-transport-test",
      );

      await expectOutbound(transport, { id: "qa-group", kind: "group" }, "assistant via fake zalo");
    });
  });

  it("injects inbound messages through Crabline and mirrors Telegram sends into normalized state", async () => {
    await withTransport("telegram", async (transport) => {
      const inbound = await transport.state.addInboundMessage({
        conversation: {
          id: "telegram-command-room",
          kind: "channel",
        },
        senderId: "100001",
        senderName: "Alice",
        text: "Channel baseline marker check.",
      });

      const api = telegramApi(transport);
      const updatesResponse = await fetch(`${api.url}/getUpdates`);
      const updates = (await updatesResponse.json()) as {
        result?: Array<{ message?: { chat?: { id?: number } } }>;
      };
      const authoritativeChatId = updates.result?.at(-1)?.message?.chat?.id;
      expect(authoritativeChatId).toEqual(expect.any(Number));
      const groupDelivery = transport.buildAgentDelivery({
        target: "channel:telegram-command-room",
      });
      expect(groupDelivery.to).toBe(String(authoritativeChatId));
      await api.post("sendMessage", {
        chat_id: transport.buildAgentDelivery({
          target: `channel:${inbound.conversation.id}`,
        }).to,
        text: "assistant via fake telegram",
      });

      await expect(
        transport.waitForOutbound({
          conversation: { id: "telegram-command-room", kind: "channel" },
          textIncludes: "assistant via fake telegram",
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({
        conversation: {
          id: "telegram-command-room",
          kind: "channel",
        },
        direction: "outbound",
        text: "assistant via fake telegram",
      });

      await transport.state.reset();
      const delivery = transport.buildAgentDelivery({ target: "dm:qa-operator" });
      await api.post("sendMessage", {
        chat_id: delivery.to,
        text: "assistant after reset",
      });

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
    });
  });
});
