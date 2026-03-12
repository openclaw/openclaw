/**
 * Zulip Message Sending
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveZulipAccount } from "./accounts.js";
import {
  createZulipClient,
  sendZulipMessage,
  uploadZulipFile,
  type ZulipClient,
} from "./client.js";

export type SendZulipMessageResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
  to?: string;
};

// Cache clients by account
const clientCache = new Map<string, ZulipClient>();

// Config getter - set by the channel plugin
let configGetter: (() => OpenClawConfig) | null = null;

export function setZulipConfigGetter(getter: () => OpenClawConfig): void {
  configGetter = getter;
}

function getOrCreateClient(accountId: string): ZulipClient | null {
  const cached = clientCache.get(accountId);
  if (cached) {
    return cached;
  }

  if (!configGetter) {
    return null;
  }

  const cfg = configGetter();
  const account = resolveZulipAccount({ cfg, accountId });

  if (!account.email || !account.apiKey || !account.baseUrl) {
    return null;
  }

  const client = createZulipClient({
    baseUrl: account.baseUrl,
    email: account.email,
    apiKey: account.apiKey,
  });

  clientCache.set(accountId, client);
  return client;
}

export function clearZulipClientCache(accountId?: string): void {
  if (accountId) {
    clientCache.delete(accountId);
  } else {
    clientCache.clear();
  }
}

/**
 * Parse a Zulip target string.
 * 
 * Formats:
 * - `stream:stream-name:topic` - Send to a stream with topic
 * - `dm:user_id` or `direct:user_id` - Send DM to user
 * - `dm:user1,user2` - Send group DM
 * - Just a stream name (assumes default topic "general")
 */
function parseZulipTarget(to: string): {
  type: "stream" | "direct";
  target: string | number[];
  topic?: string;
} | null {
  const trimmed = to.trim();
  
  // Stream format: stream:name:topic
  if (trimmed.startsWith("stream:")) {
    const parts = trimmed.slice(7).split(":");
    const streamName = parts[0];
    const topic = parts.slice(1).join(":") || "general";
    return { type: "stream", target: streamName, topic };
  }
  
  // Direct message format: dm:user_id or direct:user_id
  if (trimmed.startsWith("dm:") || trimmed.startsWith("direct:")) {
    const prefix = trimmed.startsWith("dm:") ? 3 : 7;
    const userPart = trimmed.slice(prefix);
    
    // Check for multiple users (group DM)
    if (userPart.includes(",")) {
      const userIds = userPart.split(",").map(id => parseInt(id.trim(), 10));
      if (userIds.some(isNaN)) {
        return null;
      }
      return { type: "direct", target: userIds };
    }
    
    const userId = parseInt(userPart, 10);
    if (isNaN(userId)) {
      return null;
    }
    return { type: "direct", target: [userId] };
  }
  
  // User ID format: @123 or just 123
  if (/^@?\d+$/.test(trimmed)) {
    const userId = parseInt(trimmed.replace("@", ""), 10);
    return { type: "direct", target: [userId] };
  }
  
  // Assume it's a stream name without prefix
  // Format: streamname or streamname:topic
  if (trimmed.includes(":")) {
    const [streamName, ...topicParts] = trimmed.split(":");
    return { type: "stream", target: streamName, topic: topicParts.join(":") || "general" };
  }
  
  return { type: "stream", target: trimmed, topic: "general" };
}

export async function sendMessageZulip(
  to: string,
  text: string,
  options?: {
    accountId?: string;
    replyToId?: string;
    mediaUrl?: string;
  },
): Promise<SendZulipMessageResult> {
  const accountId = options?.accountId ?? "default";
  
  const client = getOrCreateClient(accountId);
  if (!client) {
    return {
      ok: false,
      error: `Zulip account "${accountId}" not configured or missing credentials`,
    };
  }

  const parsed = parseZulipTarget(to);
  if (!parsed) {
    return {
      ok: false,
      error: `Invalid Zulip target: ${to}. Use "stream:name:topic" or "dm:user_id"`,
    };
  }

  try {
    let content = text;
    
    // Handle media attachment
    if (options?.mediaUrl) {
      // If it's a local file path or URL, we'd need to upload it first
      // For now, just include it as a link
      content = options.mediaUrl.startsWith("http")
        ? `${text}\n\n${options.mediaUrl}`
        : text;
    }

    const result = await sendZulipMessage(client, {
      type: parsed.type,
      to: parsed.target as string | number[],
      content,
      topic: parsed.topic,
    });

    return {
      ok: true,
      messageId: String(result.id),
      to,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: errorMsg,
    };
  }
}

export async function uploadAndSendMediaZulip(
  to: string,
  text: string,
  media: {
    buffer: Buffer;
    fileName: string;
    contentType?: string;
  },
  options?: {
    accountId?: string;
  },
): Promise<SendZulipMessageResult> {
  const accountId = options?.accountId ?? "default";
  
  const client = getOrCreateClient(accountId);
  if (!client) {
    return {
      ok: false,
      error: `Zulip account "${accountId}" not configured or missing credentials`,
    };
  }

  try {
    // Upload the file first
    const uploadResult = await uploadZulipFile(client, {
      buffer: media.buffer,
      fileName: media.fileName,
    });

    // Build message with the uploaded file
    const fileUrl = `${client.baseUrl}${uploadResult.uri}`;
    const content = text
      ? `${text}\n\n[${media.fileName}](${fileUrl})`
      : `[${media.fileName}](${fileUrl})`;

    // Send the message
    return await sendMessageZulip(to, content, options);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: errorMsg,
    };
  }
}
