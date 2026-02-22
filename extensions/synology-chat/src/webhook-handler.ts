/**
 * Inbound webhook handler for Synology Chat outgoing webhooks.
 * Parses form-urlencoded body, validates security, delivers to agent.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as querystring from "node:querystring";
import { sendMessage, sendToChannel } from "./client.js";
import { validateToken, checkUserAllowed, sanitizeInput, RateLimiter } from "./security.js";
import type { SynologyWebhookPayload, ResolvedSynologyChatAccount } from "./types.js";

// One rate limiter per account, created lazily
const rateLimiters = new Map<string, RateLimiter>();

function getRateLimiter(account: ResolvedSynologyChatAccount): RateLimiter {
  let rl = rateLimiters.get(account.accountId);
  if (!rl) {
    rl = new RateLimiter(account.rateLimitPerMinute);
    rateLimiters.set(account.accountId, rl);
  }
  return rl;
}

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const maxSize = 1_048_576; // 1MB

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Parse form-urlencoded body into SynologyWebhookPayload. */
function parsePayload(body: string): SynologyWebhookPayload | null {
  const parsed = querystring.parse(body);

  const token = String(parsed.token ?? "");
  const userId = String(parsed.user_id ?? "");
  const username = String(parsed.username ?? "unknown");
  const text = String(parsed.text ?? "");

  if (!token || !userId || !text) return null;

  return {
    token,
    channel_id: parsed.channel_id ? String(parsed.channel_id) : undefined,
    channel_type: parsed.channel_type ? String(parsed.channel_type) : undefined,
    channel_name: parsed.channel_name ? String(parsed.channel_name) : undefined,
    user_id: userId,
    username,
    post_id: parsed.post_id ? String(parsed.post_id) : undefined,
    timestamp: parsed.timestamp ? String(parsed.timestamp) : undefined,
    text,
    trigger_word: parsed.trigger_word ? String(parsed.trigger_word) : undefined,
  };
}

/** Send a JSON response. */
function respond(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface WebhookHandlerDeps {
  account: ResolvedSynologyChatAccount;
  deliver: (msg: {
    body: string;
    from: string;
    senderName: string;
    provider: string;
    chatType: string;
    sessionKey: string;
    accountId: string;
  }) => Promise<string | null>;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * Create an HTTP request handler for Synology Chat outgoing webhooks.
 *
 * This handler:
 * 1. Parses form-urlencoded body
 * 2. Validates token (constant-time)
 * 3. Checks user allowlist
 * 4. Checks rate limit
 * 5. Sanitizes input
 * 6. Delivers to the agent via deliver()
 * 7. Sends the agent response back to Synology Chat
 */
export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const { account, deliver, log } = deps;
  const rateLimiter = getRateLimiter(account);

  return async (req: IncomingMessage, res: ServerResponse) => {
    // Only accept POST
    if (req.method !== "POST") {
      respond(res, 405, { error: "Method not allowed" });
      return;
    }

    // Parse body
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      log?.error("Failed to read request body", err);
      respond(res, 400, { error: "Invalid request body" });
      return;
    }

    // Parse payload
    const payload = parsePayload(body);
    if (!payload) {
      respond(res, 400, { error: "Missing required fields (token, user_id, text)" });
      return;
    }

    // Token validation: accept bot token (DMs) or channel outgoing webhook tokens (groups).
    // The token determines whether this is a DM or a channel message.
    const isBotToken = validateToken(payload.token, account.token);
    let matchedChannelId: string | undefined;

    if (!isBotToken) {
      // Check channel outgoing webhook tokens
      for (const [channelId, token] of Object.entries(account.channelTokens)) {
        if (validateToken(payload.token, token)) {
          matchedChannelId = channelId;
          break;
        }
      }
      if (!matchedChannelId) {
        log?.warn(`Invalid token from ${req.socket?.remoteAddress}`);
        respond(res, 401, { error: "Invalid token" });
        return;
      }
    }

    // DM vs group is determined by which token matched:
    // - Bot token → DM (Synology Chat bot only receives direct messages)
    // - Channel outgoing webhook token → group message from that channel
    const isGroup = Boolean(matchedChannelId);

    // Apply the appropriate access policy (DM vs group)
    if (isGroup) {
      if (account.groupPolicy === "disabled") {
        respond(res, 200, { text: "" });
        return;
      }
      if (
        account.groupPolicy === "allowlist" &&
        !checkUserAllowed(payload.user_id, account.groupAllowFrom)
      ) {
        log?.warn(`User ${payload.user_id} not allowed in group mode`);
        respond(res, 200, { text: "" });
        return;
      }
    } else {
      if (account.dmPolicy === "disabled") {
        respond(res, 403, { error: "DMs are disabled" });
        return;
      }
      if (
        account.dmPolicy === "allowlist" &&
        !checkUserAllowed(payload.user_id, account.allowedUserIds)
      ) {
        log?.warn(`Unauthorized user: ${payload.user_id}`);
        respond(res, 403, { error: "User not authorized" });
        return;
      }
    }

    // Rate limit
    if (!rateLimiter.check(payload.user_id)) {
      log?.warn(`Rate limit exceeded for user: ${payload.user_id}`);
      respond(res, 429, { error: "Rate limit exceeded" });
      return;
    }

    // Sanitize input
    let cleanText = sanitizeInput(payload.text);

    // Strip trigger word
    if (payload.trigger_word && cleanText.startsWith(payload.trigger_word)) {
      cleanText = cleanText.slice(payload.trigger_word.length).trim();
    }

    if (!cleanText) {
      respond(res, 200, { text: "" });
      return;
    }

    // Build chat context
    const chatType = isGroup ? "group" : "direct";
    const channelId = matchedChannelId ?? payload.channel_id;
    const sessionKey = isGroup
      ? `synology-chat:group:${channelId}`
      : `synology-chat-${payload.user_id}`;

    const preview = cleanText.length > 100 ? `${cleanText.slice(0, 100)}...` : cleanText;
    const channelHint = isGroup ? ` [channel:${payload.channel_name ?? channelId}]` : "";
    log?.info(`Message from ${payload.username} (${payload.user_id})${channelHint}: ${preview}`);

    // Respond 200 immediately to avoid Synology Chat timeout
    respond(res, 200, { text: "Processing..." });

    // Deliver to agent asynchronously (with 120s timeout to match nginx proxy_read_timeout)
    try {
      const deliverPromise = deliver({
        body: cleanText,
        from: payload.user_id,
        senderName: payload.username,
        provider: "synology-chat",
        chatType,
        sessionKey,
        accountId: account.accountId,
      });

      const timeoutPromise = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Agent response timeout (120s)")), 120_000),
      );

      const reply = await Promise.race([deliverPromise, timeoutPromise]);

      // Send reply back via the appropriate method
      if (reply) {
        if (isGroup && channelId) {
          // Group: use the channel-specific incoming webhook
          const channelUrl = account.channelWebhooks[channelId];
          if (channelUrl) {
            await sendToChannel(channelUrl, reply, account.allowInsecureSsl);
          } else {
            log?.warn(
              `No incoming webhook configured for channel ${channelId}, falling back to DM`,
            );
            await sendMessage(
              account.incomingUrl,
              reply,
              payload.user_id,
              account.allowInsecureSsl,
            );
          }
        } else {
          // DM: use the bot's chatbot API with user_ids
          await sendMessage(account.incomingUrl, reply, payload.user_id, account.allowInsecureSsl);
        }
        const replyPreview = reply.length > 100 ? `${reply.slice(0, 100)}...` : reply;
        log?.info(`Reply sent to ${payload.username}${channelHint}: ${replyPreview}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      log?.error(`Failed to process message from ${payload.username}: ${errMsg}`);
      // Send error message via appropriate method
      const errorText = "Sorry, an error occurred while processing your message.";
      if (isGroup && channelId) {
        const channelUrl = account.channelWebhooks[channelId];
        if (channelUrl) {
          await sendToChannel(channelUrl, errorText, account.allowInsecureSsl);
        } else {
          await sendMessage(
            account.incomingUrl,
            errorText,
            payload.user_id,
            account.allowInsecureSsl,
          );
        }
      } else {
        await sendMessage(
          account.incomingUrl,
          errorText,
          payload.user_id,
          account.allowInsecureSsl,
        );
      }
    }
  };
}
