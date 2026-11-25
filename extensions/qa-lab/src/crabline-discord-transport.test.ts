import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  requireString,
  withTransport,
  type CrablineTransport,
} from "./crabline-transport.test-support.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

function discordClient(transport: CrablineTransport) {
  const discord = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" }).channels
    ?.discord;
  const apiUrl = requireString(
    transport.createRuntimeEnvPatch?.().DISCORD_API_URL,
    "Discord API URL",
  );
  const request = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${apiUrl}/${route}`, {
      method,
      headers: {
        authorization: `Bot ${requireString(discord?.token, "Discord bot token")}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok).toBe(true);
    return response;
  };
  return { discord, apiUrl, request };
}

function messagesRoute(target: string | undefined) {
  const channelId = requireString(target, "Discord delivery target").replace(/^channel:/u, "");
  return `channels/${channelId}/messages`;
}

describe("Crabline Discord transport", () => {
  it("binds Discord to the Crabline API through the Gateway environment", async () => {
    await withTransport(
      "discord",
      async (transport) => {
        const { discord, apiUrl, request } = discordClient(transport);
        const runtimeEnv = transport.createRuntimeEnvPatch?.() ?? {};

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

        const gatewayResponse = await request("gateway/bot");
        const gateway: unknown = await gatewayResponse.json();
        const gatewayUrl = requireString(
          isRecord(gateway) ? gateway.url : undefined,
          "Gateway URL",
        );
        expect(new URL(gatewayUrl).origin).toBe(new URL(apiUrl).origin.replace(/^http/u, "ws"));
        const socket = new WebSocket(gatewayUrl);
        const ready = createDeferred<unknown>();
        socket.on("error", ready.reject);
        socket.on("message", (data) => {
          const event: unknown = JSON.parse(rawDataToString(data));
          if (isRecord(event) && event.t === "READY") {
            ready.resolve(event.d);
          }
        });
        socket.on("open", () => {
          socket.send(JSON.stringify({ op: 2, d: { token: discord?.token, intents: 0 } }));
        });
        try {
          await expect(ready.promise).resolves.toMatchObject({ resume_gateway_url: gatewayUrl });
        } finally {
          socket.terminate();
        }

        const destination = {
          conversation: { id: "discord-crabline-primary", kind: "group" },
          threadId: "discord-crabline-thread",
        } as const;
        const inbound = await transport.sendInbound({
          ...destination,
          senderId: "driver",
          senderName: "QA Driver",
          text: "@openclaw Discord provider marker.",
        });
        expect(inbound).toMatchObject({
          id: expect.stringMatching(/^\d{17,20}$/u),
          ...destination,
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

        const response = await request(messagesRoute(delivery.to), "POST", {
          content: "Discord provider outbound marker.",
          message_reference: { message_id: inbound.id },
        });
        await response.body?.cancel();
        await expect(
          transport.waitForOutbound({
            ...destination,
            textIncludes: "Discord provider outbound marker.",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          replyToId: inbound.id,
          ...destination,
        });

        expect("cleanup" in transport).toBe(false);
        const beforeGatewayStop = await request("users/@me");
        await beforeGatewayStop.body?.cancel();
        await transport.cleanupAfterGatewayStop?.();
        await expect(fetch(`${runtimeEnv.DISCORD_API_URL}/users/@me`)).rejects.toThrow();
      },
      { requireGroupMention: true, senderAllowlist: ["driver"], topLevelReplies: true },
    );
  });

  it("judges retained final deliveries after the channel run drains, not matching previews", async () => {
    await withTransport("discord", async (transport) => {
      const { request } = discordClient(transport);
      const marker = "QA-TOP-LEVEL-REPLY-OK";
      let accountStatus = { accountId: transport.accountId, running: true, connected: true };
      const runQueue = createChannelRunQueue({
        setStatus: (patch) => {
          accountStatus = { ...accountStatus, ...patch };
        },
      });
      try {
        for (const [finalKind, failure] of Object.entries({
          "top-level": null,
          reply: "expected top-level reply",
          edited: "completed delivery did not contain",
          deleted: "completed without a retained reply",
          "deleted-final": "final delivery",
          "edited-final": "completed delivery did not contain",
        })) {
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
              const route = messagesRoute(delivery.to);
              const reference = { message_reference: { message_id: inbound.id } };
              runQueue.enqueue(inbound.id, async () => {
                try {
                  const previewResponse = await request(route, "POST", {
                    content: marker,
                    ...(finalKind === "top-level" ? reference : {}),
                  });
                  const preview = (await previewResponse.json()) as { id: string };
                  await releaseFinal.promise;
                  const response = await request(
                    finalKind === "edited" || finalKind === "deleted"
                      ? `${route}/${preview.id}`
                      : route,
                    finalKind === "edited" ? "PATCH" : finalKind === "deleted" ? "DELETE" : "POST",
                    finalKind === "deleted"
                      ? undefined
                      : {
                          content: finalKind === "edited" ? "wrong final" : marker,
                          ...(finalKind === "reply" ? reference : {}),
                        },
                  );
                  if (finalKind === "deleted-final" || finalKind === "edited-final") {
                    const final = (await response.json()) as { id: string };
                    expect(final.id).not.toBe(preview.id);
                    const mutation = await request(
                      `${route}/${final.id}`,
                      finalKind === "deleted-final" ? "DELETE" : "PATCH",
                      finalKind === "edited-final" ? { content: "wrong final" } : undefined,
                    );
                    await mutation.body?.cancel();
                  } else {
                    await response.body?.cancel();
                  }
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
          if (failure) {
            await expect(result).rejects.toThrow(failure);
          } else {
            await expect(result).resolves.toMatchObject({ status: "pass" });
          }
        }
      } finally {
        runQueue.deactivate();
      }
    });
  });
});
