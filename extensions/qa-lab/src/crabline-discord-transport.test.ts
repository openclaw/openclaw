import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

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
        transportPolicy: {
          requireGroupMention: true,
          senderAllowlist: ["driver"],
          topLevelReplies: true,
        },
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
          replyToMode: "off",
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
          id: expect.stringMatching(/^\d{17,20}$/u),
          conversation: { id: "discord-crabline-primary", kind: "group" },
          threadId: "discord-crabline-thread",
        });
        const delivery = transport.buildAgentDelivery({
          target: "group:discord-crabline-primary",
          threadId: "discord-crabline-thread",
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
            body: JSON.stringify({
              content: "Discord provider outbound marker.",
              message_reference: { message_id: inbound.id },
            }),
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
          replyToId: inbound.id,
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

  it("judges retained final deliveries after the channel run drains, not matching previews", async () => {
    await withTempDir("qa-crabline-discord-finals-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: {
          capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
          channel: "discord",
          channelDriver: "crabline",
          providerReadinessArtifactPath: "crabline-provider-readiness.json",
        },
      });
      const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
      const apiUrl = transport.createRuntimeEnvPatch?.().DISCORD_API_URL;
      const headers = {
        authorization: `Bot ${requireString(config.channels?.discord?.token, "Discord bot token")}`,
        "content-type": "application/json",
      };
      const marker = "QA-TOP-LEVEL-REPLY-OK";
      let accountStatus = { accountId: transport.accountId, running: true, connected: true };
      const runQueue = createChannelRunQueue({
        setStatus: (patch) => {
          accountStatus = { ...accountStatus, ...patch };
        },
      });
      try {
        for (const finalKind of ["top-level", "reply", "edited", "deleted"] as const) {
          const releaseFinal = createDeferred<void>();
          const waitingForDelivery = createDeferred<"waiting">();
          const deliveryDone = createDeferred<void>();
          const gateway = {
            call: async () => {
              waitingForDelivery.resolve("waiting");
              return { channelAccounts: { discord: [accountStatus] } };
            },
          };
          const flowTransport = {
            ...transport,
            sendInbound: async (input: Parameters<typeof transport.sendInbound>[0]) => {
              const inbound = await transport.sendInbound(input);
              const delivery = transport.buildAgentDelivery({
                target: `group:${input.conversation.id}`,
              });
              const channelId = requireString(delivery.to, "Discord delivery target").replace(
                /^channel:/u,
                "",
              );
              const messagesUrl = `${apiUrl}/channels/${channelId}/messages`;
              runQueue.enqueue(inbound.id, async () => {
                try {
                  const previewResponse = await fetch(messagesUrl, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                      content: marker,
                      ...(finalKind === "top-level"
                        ? { message_reference: { message_id: inbound.id } }
                        : {}),
                    }),
                  });
                  expect(previewResponse.ok).toBe(true);
                  const preview = (await previewResponse.json()) as { id: string };
                  await releaseFinal.promise;
                  const response = await fetch(
                    finalKind === "edited" || finalKind === "deleted"
                      ? `${messagesUrl}/${preview.id}`
                      : messagesUrl,
                    {
                      method:
                        finalKind === "edited"
                          ? "PATCH"
                          : finalKind === "deleted"
                            ? "DELETE"
                            : "POST",
                      headers,
                      ...(finalKind === "deleted"
                        ? {}
                        : {
                            body: JSON.stringify({
                              content: finalKind === "edited" ? "wrong final" : marker,
                              ...(finalKind === "reply"
                                ? { message_reference: { message_id: inbound.id } }
                                : {}),
                            }),
                          }),
                    },
                  );
                  expect(response.ok).toBe(true);
                  await response.body?.cancel();
                  deliveryDone.resolve();
                } catch (error) {
                  deliveryDone.reject(error);
                }
              });
              return inbound;
            },
          };
          const result = runLoadedScenarioFlow("channel-top-level-reply-shape", {
            api: { transport: flowTransport, env: { gateway } },
          });
          const observed = result.then(
            () => "completed",
            () => "failed",
          );
          try {
            expect(await Promise.race([waitingForDelivery.promise, observed])).toBe("waiting");
          } finally {
            releaseFinal.resolve();
            await deliveryDone.promise;
          }
          if (finalKind === "top-level") {
            await expect(result).resolves.toMatchObject({ status: "pass" });
          } else {
            await expect(result).rejects.toThrow(
              finalKind === "reply"
                ? "expected top-level reply"
                : finalKind === "edited"
                  ? "completed delivery did not contain"
                  : "completed without a retained reply",
            );
          }
        }
      } finally {
        runQueue.deactivate();
        await transport.cleanupAfterGatewayStop?.();
      }
    });
  });
});
