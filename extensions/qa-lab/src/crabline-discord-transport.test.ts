import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

describe("Crabline Discord transport", () => {
  it("binds Discord to the Crabline API through the Gateway environment", async () => {
    await withTempDir("qa-crabline-discord-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: {
          capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
          channel: "discord",
          channelDriver: "crabline",
          providerReadinessArtifactPath: "crabline-provider-readiness.json",
        },
        state: createQaBusState(),
        transportPolicy: { requireGroupMention: true, senderAllowlist: ["driver"] },
      });
      const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
      const discord = config.channels?.discord;
      const runtimeEnv = transport.createRuntimeEnvPatch?.() ?? {};

      try {
        expect(transport.requiredPluginIds).toEqual(["discord"]);
        expect(runtimeEnv).toEqual({
          DISCORD_API_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/api\/v10$/u),
        });
        expect(discord).toMatchObject({
          allowFrom: [expect.stringMatching(/^\d{17,20}$/u)],
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          guilds: {
            "*": {
              channels: { "*": { enabled: true, requireMention: true } },
              users: [expect.stringMatching(/^\d{17,20}$/u)],
            },
          },
        });

        const inbound = await transport.sendInbound({
          conversation: { id: "discord-crabline-primary", kind: "group" },
          senderId: "driver",
          senderName: "QA Driver",
          text: "@openclaw Discord provider marker.",
          threadId: "discord-crabline-thread",
        });
        expect(inbound).toMatchObject({
          conversation: { id: "discord-crabline-primary", kind: "group" },
          threadId: "discord-crabline-thread",
        });
        const delivery = transport.buildAgentDelivery({
          target: "thread:discord-crabline-primary/discord-crabline-thread",
        });
        expect(delivery).toMatchObject({
          channel: "discord",
          replyChannel: "discord",
          replyTo: expect.stringMatching(/^channel:\d{17,20}$/u),
          to: expect.stringMatching(/^channel:\d{17,20}$/u),
        });

        const channelId = requireString(delivery.to, "Discord delivery target").replace(
          /^channel:/u,
          "",
        );
        const response = await fetch(
          `${runtimeEnv.DISCORD_API_URL}/channels/${channelId}/messages`,
          {
            body: JSON.stringify({ content: "Discord provider outbound marker." }),
            headers: {
              authorization: `Bot ${requireString(discord?.token, "Discord bot token")}`,
              "content-type": "application/json",
            },
            method: "POST",
          },
        );
        expect(response.ok).toBe(true);
        await response.body?.cancel();
        await expect(
          transport.waitForOutbound({
            conversation: { id: "discord-crabline-primary", kind: "group" },
            textIncludes: "Discord provider outbound marker.",
            threadId: "discord-crabline-thread",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: "discord-crabline-primary", kind: "group" },
          threadId: "discord-crabline-thread",
        });

        expect("cleanup" in transport).toBe(false);
        const beforeGatewayStop = await fetch(`${runtimeEnv.DISCORD_API_URL}/users/@me`, {
          headers: { authorization: `Bot ${requireString(discord?.token, "Discord bot token")}` },
        });
        expect(beforeGatewayStop.ok).toBe(true);
        await beforeGatewayStop.body?.cancel();
        await transport.cleanupAfterGatewayStop?.();
        await expect(fetch(`${runtimeEnv.DISCORD_API_URL}/users/@me`)).rejects.toThrow();
      } finally {
        await transport.cleanupAfterGatewayStop?.();
      }
    });
  });
});
