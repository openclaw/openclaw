import type {
  ChannelPlugin,
  ChannelOutboundAdapter,
  ChannelGatewayAdapter,
  OpenClawConfig,
  OutboundDeliveryResult,
} from "openclaw/plugin-sdk";

// Simple resolved account type - just needs an ID
type ResolvedPlatformAccount = {
  accountId: string;
  webhookUrl?: string;
  secret?: string;
};

const outbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  sendText: async (ctx): Promise<OutboundDeliveryResult> => {
    const webhookUrl = process.env.ELSE_PLATFORM_WEBHOOK_URL;
    const secret = process.env.ELSE_PLATFORM_SECRET;

    if (!webhookUrl) {
      return {
        ok: false,
        error: new Error("ELSE_PLATFORM_WEBHOOK_URL not configured"),
      };
    }

    try {
      // Use native fetch (Node 18+)
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { "X-Platform-Secret": secret } : {}),
        },
        body: JSON.stringify({
          to: ctx.to,
          text: ctx.text,
          replyToId: ctx.replyToId,
          threadId: ctx.threadId,
        }),
      });

      if (!response.ok) {
        return {
          ok: false,
          error: new Error(`Webhook failed: ${response.status} ${response.statusText}`),
        };
      }

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },
};

const gateway: ChannelGatewayAdapter<ResolvedPlatformAccount> = {
  startAccount: async (ctx) => {
    const port = Number(process.env.ELSE_PLATFORM_PORT) || 3000;
    const secret = process.env.ELSE_PLATFORM_SECRET;

    ctx.log?.info(`Starting platform-channel (HTTP server on port ${port})`);

    // NOTE: Actual HTTP server implementation would be in the core OpenClaw codebase
    // This is a placeholder that demonstrates the structure
    // In a real implementation, this would:
    // 1. Start an HTTP server on the configured port
    // 2. Validate incoming requests with the secret
    // 3. Deliver messages to the OpenClaw agent
    // 4. Return appropriate responses

    return {
      mode: "webhook",
      port,
      status: "running",
    };
  },
  stopAccount: async (ctx) => {
    ctx.log?.info("Stopping platform-channel server");
    // Server cleanup would be handled here
  },
};

export const platformChannelPlugin: ChannelPlugin<ResolvedPlatformAccount> = {
  id: "platform-channel",
  meta: {
    name: "Platform Channel",
    description: "Receives messages from else-platform via HTTP",
    quickstartAllowFrom: false,
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: true,
    media: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.platform-channel"] },
  config: {
    listAccountIds: (cfg: OpenClawConfig) => ["default"],
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): ResolvedPlatformAccount => {
      return {
        accountId: accountId || "default",
        webhookUrl: process.env.ELSE_PLATFORM_WEBHOOK_URL,
        secret: process.env.ELSE_PLATFORM_SECRET,
      };
    },
    defaultAccountId: () => "default",
  },
  outbound,
  gateway,
};
