// QA Lab tests cover the Discord-specific Crabline provider lifecycle.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { CRABLINE_DISCORD_PROVIDER_ENDPOINT_ARTIFACT } from "./crabline-discord-provider-endpoint-artifact.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

const DISCORD_SELECTION = {
  capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
  channel: "discord",
  channelDriver: "crabline",
  providerReadinessArtifactPath: "crabline-provider-readiness.json",
} as const satisfies OpenClawCrablineChannelDriverSelection;

describe("Crabline Discord transport", () => {
  it("stages the private endpoint and closes the provider after the Gateway phase", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        transportPolicy: { requireGroupMention: true, senderAllowlist: ["driver"] },
        selection: DISCORD_SELECTION,
        state: createQaBusState(),
      });
      const gatewayTempRoot = path.join(outputDir, "gateway-temp");
      await fs.mkdir(gatewayTempRoot);

      try {
        expect(transport.requiredPluginIds).toEqual(["qa-lab", "discord"]);
        const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
        const discord = config.channels?.discord as
          | {
              applicationId?: string;
              guilds?: Record<string, { channels?: Record<string, unknown>; users?: string[] }>;
              token?: string;
            }
          | undefined;
        expect(discord).toMatchObject({
          allowFrom: [expect.stringMatching(/^\d{17,20}$/u)],
          applicationId: expect.stringMatching(/^\d{17,20}$/u),
          dmPolicy: "allowlist",
          guilds: {
            "*": {
              channels: { "*": { enabled: true, requireMention: true } },
              users: [expect.stringMatching(/^\d{17,20}$/u)],
            },
          },
          token: expect.any(String),
        });

        await transport.stageGatewayRuntime?.({ tempRoot: gatewayTempRoot });
        const descriptorPath = path.join(
          gatewayTempRoot,
          CRABLINE_DISCORD_PROVIDER_ENDPOINT_ARTIFACT,
        );
        const descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8")) as {
          gatewayBotUrl: string;
          gatewayOrigin: string;
          restApiBaseUrl: string;
        };
        expect(descriptor).toEqual({
          gatewayBotUrl: expect.stringMatching(
            /^http:\/\/127\.0\.0\.1:\d+\/api\/v10\/gateway\/bot$/u,
          ),
          gatewayOrigin: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/u),
          restApiBaseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/api\/v10$/u),
        });
        if (process.platform !== "win32") {
          expect((await fs.stat(descriptorPath)).mode & 0o077).toBe(0);
        }

        await expect(
          transport.sendInbound({
            conversation: { id: "discord-crabline-primary", kind: "group" },
            senderId: "driver",
            senderName: "QA Driver",
            text: "@openclaw Discord provider marker.",
            threadId: "discord-crabline-thread",
          }),
        ).resolves.toMatchObject({
          conversation: { id: "discord-crabline-primary", kind: "group" },
          text: "@openclaw Discord provider marker.",
          threadId: "discord-crabline-thread",
        });
        const delivery = transport.buildAgentDelivery({
          target: "thread:discord-crabline-primary/discord-crabline-thread",
        });
        expect(delivery).toEqual({
          channel: "discord",
          replyChannel: "discord",
          replyTo: expect.stringMatching(/^channel:\d{17,20}$/u),
          to: expect.stringMatching(/^channel:\d{17,20}$/u),
        });

        const probeUrl = `${descriptor.restApiBaseUrl}/users/@me`;
        const headers = { authorization: `Bot ${discord?.token}` };
        const channelId = delivery.to?.replace(/^channel:/u, "");
        const outboundResponse = await fetch(
          `${descriptor.restApiBaseUrl}/channels/${channelId}/messages`,
          {
            body: JSON.stringify({ content: "Discord provider outbound marker." }),
            headers: { ...headers, "content-type": "application/json" },
            method: "POST",
          },
        );
        expect(outboundResponse.ok).toBe(true);
        await outboundResponse.body?.cancel();
        await expect(
          transport.waitForOutbound({
            conversation: { id: "discord-crabline-primary", kind: "group" },
            textIncludes: "Discord provider outbound marker.",
            threadId: "discord-crabline-thread",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: "discord-crabline-primary", kind: "group" },
          text: "Discord provider outbound marker.",
          threadId: "discord-crabline-thread",
        });
        const beforeCleanup = await fetch(probeUrl, { headers });
        expect(beforeCleanup.ok).toBe(true);
        await beforeCleanup.body?.cancel();

        await transport.cleanup?.();
        const beforeGatewayStop = await fetch(probeUrl, { headers });
        expect(beforeGatewayStop.ok).toBe(true);
        await beforeGatewayStop.body?.cancel();

        await transport.cleanupAfterGatewayStop?.();
        await expect(fetch(probeUrl, { headers })).rejects.toThrow();
      } finally {
        await transport.cleanupAfterGatewayStop?.();
      }
    });
  });

  it("completes Crabline's open Discord DM binding without a sender restriction", async () => {
    await withTempDir("qa-crabline-discord-open-dm-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: DISCORD_SELECTION,
        state: createQaBusState(),
      });

      try {
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: { discord: { allowFrom: ["*"], dmPolicy: "open" } },
        });
      } finally {
        await transport.cleanupAfterGatewayStop?.();
      }
    });
  });
});
