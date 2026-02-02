import mqtt from "mqtt";
import {
  getChatChannelMeta,
  type ChannelPlugin,
  type ChannelGatewayContext,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk";
import { listSpixiAccountIds, resolveSpixiAccount } from "./accounts.js";
import { spixiOnboardingAdapter } from "./onboarding.js";
import { getSpixiRuntime, setSpixiBaseUrl } from "./runtime.js";
import { SpixiConfigSchema } from "./schema.js";
import { type ResolvedSpixiAccount } from "./types.js";

const meta = getChatChannelMeta("spixi");

export const spixiPlugin: ChannelPlugin<ResolvedSpixiAccount> = {
  id: "spixi",
  meta: {
    ...meta,
    showConfigured: true,
    quickstartAllowFrom: true,
  },
  onboarding: spixiOnboardingAdapter,
  configSchema: buildChannelConfigSchema(SpixiConfigSchema),
  config: {
    listAccountIds: (cfg: unknown) => listSpixiAccountIds(cfg),
    resolveAccount: (cfg: unknown, accountId: string | null | undefined) =>
      resolveSpixiAccount({ cfg, accountId }),
    isConfigured: (account: ResolvedSpixiAccount) => account.configured,
  },
  agentTools: () => [
    {
      name: "spixi_add_contact",
      description: "Add a new Spixi contact and send a friend request.",
      schema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "The Spixi wallet address to add.",
          },
        },
        required: ["address"],
      },
      run: async ({ address }: { address: string }) => {
        const runtime = getSpixiRuntime();
        return await runtime.channel.spixi.addContact(address);
      },
    },
    {
      name: "spixi_accept_contact",
      description: "Accept a pending Spixi friend request.",
      schema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "The Spixi wallet address to accept.",
          },
        },
        required: ["address"],
      },
      run: async ({ address }: { address: string }) => {
        const runtime = getSpixiRuntime();
        return await runtime.channel.spixi.acceptContact(address);
      },
    },
  ],
  capabilities: {
    chatTypes: ["direct"],
    polls: false,
    reactions: false,
    media: false,
  },
  outbound: {
    deliveryMode: "gateway",
    sendText: async ({ to, text }: { to: string; text: string }) => {
      const runtime = getSpixiRuntime();
      const result = await runtime.channel.spixi.sendMessage(to, text);
      return { channel: "spixi", ...(typeof result === "object" && result !== null ? result : {}) };
    },
  },
  gateway: {
    startAccount: async (ctx: ChannelGatewayContext<ResolvedSpixiAccount>) => {
      const { account, log } = ctx;
      const config = account.config;

      // Debug logging
      log?.info(
        `[${account.accountId}] Spixi config:`,
        JSON.stringify({
          enabled: account.enabled,
          configured: account.configured,
          mqttHost: config.mqttHost,
          mqttPort: config.mqttPort,
          quixiApiUrl: config.quixiApiUrl,
          allowFrom: config.allowFrom,
        }),
      );

      const mqttUrl = `mqtt://${config.mqttHost || "127.0.0.1"}:${config.mqttPort || 1883}`;

      log?.info(`[${account.accountId}] connecting to Spixi MQTT: ${mqttUrl}`);

      // Configure QuIXI API base URL from config
      if (config.quixiApiUrl) {
        setSpixiBaseUrl(config.quixiApiUrl);
      }

      const runtime = getSpixiRuntime();

      // Auto-friend sync: fetch existing friends, add any from allowFrom that are missing
      try {
        const existingFriends = await runtime.channel.spixi.getFriendList();
        const existingSet = new Set(existingFriends.map((addr) => addr.toLowerCase()));

        const allowFrom = config.allowFrom || [];
        for (const address of allowFrom) {
          const trimmed = address?.trim();
          if (!trimmed || trimmed === "*") {
            continue;
          }

          if (!existingSet.has(trimmed.toLowerCase())) {
            log?.info(`[${account.accountId}] Auto-adding friend: ${trimmed}`);
            try {
              await runtime.channel.spixi.addContact(trimmed);
              log?.info(`[${account.accountId}] Friend request sent to: ${trimmed}`);
            } catch (e: unknown) {
              const err = e as Error;
              log?.warn(`[${account.accountId}] Failed to add friend ${trimmed}: ${err.message}`);
            }
          }
        }

        log?.info(
          `[${account.accountId}] Friend sync complete. ${existingFriends.length} existing friends.`,
        );
      } catch (e: unknown) {
        const err = e as Error;
        log?.warn(`[${account.accountId}] Could not sync friends: ${err.message}`);
      }

      const client = mqtt.connect(mqttUrl);

      client.on("connect", () => {
        log?.info(`[${account.accountId}] Spixi MQTT Connected`);
        client.subscribe("Chat");
        client.subscribe("RequestAdd2");
        client.subscribe("AcceptAdd2");
      });

      client.on("message", async (topic: string, message: mqtt.Packet) => {
        const msgStr = message;
        let data: unknown;
        try {
          data = JSON.parse(msgStr);
        } catch {
          log?.warn(`[${account.accountId}] Received invalid JSON on ${topic}`);
          return;
        }

        if (topic === "Chat") {
          try {
            const d = data as {
              sender?: string;
              data?: { data?: string };
              message?: string;
              id?: string;
              timestamp?: number;
            };
            if (typeof d === "object" && d !== null && d.sender && (d.data?.data || d.message)) {
              const sender = d.sender;
              // Prefer d.data?.data, fallback to d.message
              let text: string | undefined;
              if (d.data && typeof d.data === "object" && d.data.data) {
                text = d.data.data;
              } else if (d.message) {
                text = d.message;
              }

              if (!text || (config.myWalletAddress && sender === config.myWalletAddress)) {
                return;
              }

              log?.info(`[${account.accountId}] Received Spixi message from ${sender}: ${text}`);

              // Inbound relay logic to OpenClaw core
              if (ctx.onMessage) {
                ctx.onMessage({
                  id: d.id || `spixi-${Date.now()}`,
                  from: sender,
                  text,
                  timestamp: d.timestamp || Date.now(),
                  raw: data,
                });
              } else {
                log?.warn(`[${account.accountId}] ctx.onMessage not available - message dropped`);
              }
            } else {
              log?.warn(`[${account.accountId}] Unexpected Spixi chat message shape`);
            }
          } catch (e: unknown) {
            const err = e as Error;
            log?.error(`[${account.accountId}] Error processing Spixi chat: ${err.message}`);
          }
        } else if (topic === "RequestAdd2") {
          // Incoming friend request
          const d = data as { sender?: string; address?: string };
          let sender: string | undefined;
          if (typeof d === "object" && d !== null && (d.sender || d.address)) {
            sender = d.sender || d.address;
          }
          log?.info(`[${account.accountId}] Received Friend Request from: ${sender}`);

          // Check if in allowFrom
          const allowFrom = (config.allowFrom || []).map((a: string) => a.toLowerCase().trim());
          if (sender && allowFrom.includes(sender.toLowerCase())) {
            log?.info(
              `[${account.accountId}] Auto-accepting friend request from allowed sender: ${sender}`,
            );
            try {
              const runtime = getSpixiRuntime();
              await runtime.channel.spixi.acceptContact(sender);
              log?.info(`[${account.accountId}] Accepted friend request from ${sender}`);
            } catch (e: unknown) {
              const err = e as Error;
              log?.error(`[${account.accountId}] Failed to accept friend: ${err.message}`);
            }
          } else {
            log?.info(
              `[${account.accountId}] Friend request from ${sender} pending (not in allowFrom)`,
            );
            // TODO: Ideally create a system notification or similar
          }
        } else if (topic === "AcceptAdd2") {
          // Friend request accepted by other party
          const d = data as { sender?: string; address?: string };
          let sender: string | undefined;
          if (typeof d === "object" && d !== null && (d.sender || d.address)) {
            sender = d.sender || d.address;
          }
          log?.info(`[${account.accountId}] Friend request ACCEPTED by: ${sender}`);
        }
      });

      // Attach capabilities to the shared runtime object so server.impl.ts can see them
      Object.assign(ctx.runtime, getSpixiRuntime());

      return new Promise<void>((resolve) => {
        const onAbort = () => {
          log?.info(`[${account.accountId}] stopping spixi bridge`);
          client.end();
          resolve();
        };

        if (ctx.abortSignal.aborted) {
          onAbort();
          return;
        }

        ctx.abortSignal.addEventListener("abort", () => {
          onAbort();
        });
      });
    },
  },
};
