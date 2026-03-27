/**
 * GenPark Circle Channel Plugin
 *
 * Implements the OpenClaw ChannelPlugin interface for GenPark Circle.
 * Handles inbound webhooks from Circle and outbound message sending.
 *
 * NOTE FOR GENPARK ENGINEERS:
 * - The webhook payload shape in `handleInbound` is modeled on typical
 *   Circle webhook patterns. Adjust field names to match your actual webhook.
 * - The `sendMessage` method calls the GenPark REST API to post replies.
 */

import {
  GenParkClient,
  GenParkApiError,
  type CircleMessage,
} from "./api-client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenParkChannelConfig {
  genpark_api_token: string;
  circle_id?: string;
  circle_webhook_secret?: string;
  marketplace_enabled?: boolean;
}

interface InboundWebhookPayload {
  event: "message.created" | "mention" | "thread.reply";
  data: {
    id: string;
    circleId: string;
    threadId?: string;
    authorId: string;
    authorName: string;
    content: string;
    createdAt: string;
    attachments?: Array<{
      url: string;
      mimeType?: string;
      filename?: string;
    }>;
  };
  signature?: string;
}

interface OutboundMessage {
  channelId: string; // "circleId:threadId"
  content: string;
  replyToMessageId?: string;
}

// ---------------------------------------------------------------------------
// Session Key Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a GenPark session key from Circle IDs.
 * Format: "genpark:circleId:threadId" or "genpark:circleId" for top-level.
 */
export function normalizeSessionKey(
  circleId: string,
  threadId?: string,
): string {
  const base = `genpark:${circleId}`;
  return threadId ? `${base}:${threadId}` : base;
}

/**
 * Parse a channel target string back into circleId and optional threadId.
 */
export function parseChannelTarget(target: string): {
  circleId: string;
  threadId?: string;
} {
  const parts = target.split(":");
  if (parts.length >= 3 && parts[0] === "genpark") {
    return { circleId: parts[1]!, threadId: parts[2] };
  }
  if (parts.length === 2 && parts[0] === "genpark") {
    return { circleId: parts[1]! };
  }
  // Fallback: treat entire string as circleId
  return { circleId: target };
}

// ---------------------------------------------------------------------------
// Channel Plugin
// ---------------------------------------------------------------------------

let client: GenParkClient | null = null;
let pluginConfig: GenParkChannelConfig | null = null;

export const genparkPlugin = {
  id: "genpark" as const,

  /**
   * Initialize the GenPark channel plugin.
   * Validates the API token and sets up the client.
   */
  async initialize(config: GenParkChannelConfig): Promise<void> {
    if (!config.genpark_api_token) {
      console.warn(
        "[GenPark] No API token configured. Set channels.genpark.genpark_api_token in openclaw.json",
      );
      return;
    }

    pluginConfig = config;
    client = new GenParkClient({ apiToken: config.genpark_api_token });

    // Validate the token by fetching the authenticated user
    try {
      const me = await client.getMe();
      console.log(
        `[GenPark] Authenticated as ${me.displayName ?? me.username} (${me.id})`,
      );
    } catch (err) {
      if (err instanceof GenParkApiError && err.isUnauthorized) {
        console.error(
          "[GenPark] Invalid API token. Please check your configuration.",
        );
        client = null;
        return;
      }
      // Network errors during init are non-fatal — we'll retry on message send
      console.warn("[GenPark] Could not validate token on init:", err);
    }

    if (config.circle_id) {
      console.log(`[GenPark] Watching Circle: ${config.circle_id}`);
    }

    console.log("[GenPark] Channel plugin initialized.");
  },

  /**
   * Handle an inbound webhook from GenPark Circle.
   *
   * Returns a normalized message object that the Gateway can route to
   * the appropriate agent session.
   */
  handleInbound(
    payload: InboundWebhookPayload,
  ): {
    sessionKey: string;
    sender: string;
    senderName: string;
    content: string;
    raw: InboundWebhookPayload;
  } | null {
    // Validate webhook signature if configured
    if (pluginConfig?.circle_webhook_secret && payload.signature) {
      // NOTE FOR GENPARK ENGINEERS:
      // Replace this with your actual HMAC signature verification logic.
      // Example: verify HMAC-SHA256(secret, rawBody) === payload.signature
      const isValid = verifyWebhookSignature(
        payload.signature,
        pluginConfig.circle_webhook_secret,
      );
      if (!isValid) {
        console.warn("[GenPark] Invalid webhook signature — dropping payload.");
        return null;
      }
    }

    const { data } = payload;

    // Skip messages from the bot itself to prevent loops
    // NOTE: Replace "openclaw-bot" with your actual bot user ID
    if (data.authorId === "openclaw-bot") {
      return null;
    }

    const sessionKey = normalizeSessionKey(data.circleId, data.threadId);

    return {
      sessionKey,
      sender: data.authorId,
      senderName: data.authorName,
      content: data.content,
      raw: payload,
    };
  },

  /**
   * Send a message to a GenPark Circle thread.
   */
  async sendMessage(outbound: OutboundMessage): Promise<CircleMessage | null> {
    if (!client) {
      console.error(
        "[GenPark] Cannot send message — client not initialized. Check your API token.",
      );
      return null;
    }

    const { circleId, threadId } = parseChannelTarget(outbound.channelId);

    try {
      if (threadId) {
        // Reply in existing thread
        return await client.postCircleMessage(
          circleId,
          threadId,
          outbound.content,
        );
      } else {
        // Create a new thread
        const thread = await client.createCircleThread(
          circleId,
          "OpenClaw Response",
          outbound.content,
        );
        console.log(`[GenPark] Created new thread: ${thread.id}`);
        return null;
      }
    } catch (err) {
      if (err instanceof GenParkApiError) {
        if (err.isRateLimited) {
          console.warn("[GenPark] Rate limited. Message will be retried.");
        } else if (err.isForbidden) {
          console.error(
            "[GenPark] 403 Forbidden — your API token may lack permissions. " +
              "Upgrade at https://genpark.ai/pricing",
          );
        }
      }
      console.error("[GenPark] Failed to send message:", err);
      return null;
    }
  },

  /**
   * Gracefully shut down the channel.
   */
  async shutdown(): Promise<void> {
    console.log("[GenPark] Shutting down channel plugin.");
    client = null;
    pluginConfig = null;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Placeholder webhook signature verification.
 * NOTE FOR GENPARK ENGINEERS: Replace with actual HMAC verification.
 */
function verifyWebhookSignature(
  _signature: string,
  _secret: string,
): boolean {
  // TODO: Implement actual HMAC-SHA256 verification
  // const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  return true;
}

/**
 * Get the current GenPark client instance (for use by other modules).
 */
export function getGenParkClient(): GenParkClient | null {
  return client;
}
