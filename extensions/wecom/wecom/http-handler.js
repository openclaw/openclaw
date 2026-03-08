import * as crypto from "node:crypto";
import { logger } from "../logger.js";
import { streamManager } from "../stream-manager.js";
import { WecomWebhook } from "../webhook.js";
import { handleAgentInbound } from "./agent-inbound.js";
import {
  extractLeadingSlashCommand,
  isHighPriorityCommand,
} from "./commands.js";
import {
  DEBOUNCE_MS,
  MAIN_RESPONSE_IDLE_CLOSE_MS,
  THINKING_PLACEHOLDER,
} from "./constants.js";
import {
  flushMessageBuffer,
  processInboundMessage,
} from "./inbound-processor.js";
import { messageBuffers, streamMeta, webhookTargets } from "./state.js";
import {
  clearBufferedMessagesForStream,
  getMessageStreamKey,
  handleStreamError,
} from "./stream-utils.js";
import { MessageDeduplicator } from "../utils.js";
import { normalizeWebhookPath } from "./webhook-targets.js";

/** Maximum allowed request body size for Bot mode POST (1 MB). */
const MAX_BOT_BODY_SIZE = 1 * 1024 * 1024;

/**
 * Shared deduplicator instance — persists across requests so that
 * duplicate message IDs are correctly suppressed.
 */
const sharedDeduplicator = new MessageDeduplicator();

export async function wecomHttpHandler(req, res) {
  const url = new URL(req.url || "", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);

  if (!targets || targets.length === 0) {
    return false; // Not handled by this plugin
  }

  const query = Object.fromEntries(url.searchParams);
  logger.debug("WeCom HTTP request", { method: req.method, path });

  // ── Agent inbound: route to dedicated handler when target has agentInbound config ──
  const agentTarget = targets.find((t) => t.account?.agentInbound);
  if (agentTarget) {
    return handleAgentInbound({
      req,
      res,
      agentAccount: agentTarget.account.agentInbound,
      config: agentTarget.config,
    });
  }

  // ── Bot mode: JSON-based stream handling ──

  // GET: URL Verification
  if (req.method === "GET") {
    const target = targets[0]; // Use first target for verification
    if (!target) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("No webhook target configured");
      return true;
    }

    const webhook = new WecomWebhook({
      token: target.account.token,
      encodingAesKey: target.account.encodingAesKey,
    });

    const echo = webhook.handleVerify(query);
    if (echo) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(echo);
      logger.info("WeCom URL verification successful");
      return true;
    }

    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Verification failed");
    logger.warn("WeCom URL verification failed");
    return true;
  }

  // POST: Message handling
  if (req.method === "POST") {
    const target = targets[0];
    if (!target) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("No webhook target configured");
      return true;
    }

    // Read request body with size limit.
    const chunks = [];
    let bodySize = 0;
    for await (const chunk of req) {
      bodySize += chunk.length;
      if (bodySize > MAX_BOT_BODY_SIZE) {
        res.writeHead(413, { "Content-Type": "text/plain" });
        res.end("Payload Too Large");
        logger.warn("WeCom POST body exceeded size limit", { bodySize });
        return true;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf-8");
    logger.debug("WeCom message received", { bodyLength: body.length });

    const webhook = new WecomWebhook(
      {
        token: target.account.token,
        encodingAesKey: target.account.encodingAesKey,
      },
      sharedDeduplicator,
    );

    const result = await webhook.handleMessage(query, body);
    if (result === WecomWebhook.DUPLICATE) {
      // Duplicate message — ACK 200 to prevent platform retry storm.
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("success");
      return true;
    }
    if (!result) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return true;
    }

    // Handle text message
    if (result.message) {
      const msg = result.message;
      const { timestamp, nonce } = result.query;
      const content = (msg.content || "").trim();

      // Use stream responses for every inbound message, including commands.
      // WeCom AI Bot response_url is single-use, so streaming is mandatory.
      const streamId = `stream_${crypto.randomUUID()}`;
      streamManager.createStream(streamId);
      streamManager.appendStream(streamId, THINKING_PLACEHOLDER);

      // Passive reply: return stream id immediately in the sync response.
      // Include the placeholder so the client displays it right away.
      const streamResponse = webhook.buildStreamResponse(
        streamId,
        THINKING_PLACEHOLDER,
        false,
        timestamp,
        nonce,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(streamResponse);

      logger.info("Stream initiated", {
        streamId,
        from: msg.fromUser,
        isCommand: content.startsWith("/"),
      });

      // Stamp accountId onto the message so getMessageStreamKey generates an
      // account-scoped key, matching the prefixed streamKey in inbound-processor.
      msg.accountId = target.account.accountId;
      const streamKey = getMessageStreamKey(msg);
      const isCommand = content.startsWith("/");
      const leadingCommand = extractLeadingSlashCommand(content);
      const highPriorityCommand = isHighPriorityCommand(leadingCommand);

      if (highPriorityCommand) {
        const drained = clearBufferedMessagesForStream(
          streamKey,
          `消息已被 ${leadingCommand} 中断。`,
        );
        if (drained > 0) {
          logger.info(
            "WeCom: drained buffered messages before high-priority command",
            {
              streamKey,
              command: leadingCommand,
              drained,
            },
          );
        }
      }

      // Commands bypass debounce — process immediately.
      if (isCommand) {
        processInboundMessage({
          message: msg,
          streamId,
          timestamp,
          nonce,
          account: target.account,
          config: target.config,
        }).catch(async (err) => {
          logger.error("WeCom message processing failed", {
            error: err.message,
          });
          await handleStreamError(
            streamId,
            streamKey,
            "处理消息时出错，请稍后再试。",
          );
        });
        return true;
      }

      // Debounce: buffer non-command messages per user/group.
      // If multiple messages arrive within DEBOUNCE_MS, merge into one dispatch.
      const existing = messageBuffers.get(streamKey);
      if (existing) {
        // A previous message is still buffered — merge this one in.
        existing.messages.push(msg);
        existing.streamIds.push(streamId);
        clearTimeout(existing.timer);
        existing.timer = setTimeout(
          () => flushMessageBuffer(streamKey, target),
          DEBOUNCE_MS,
        );
        logger.info("WeCom: message buffered for merge", {
          streamKey,
          streamId,
          buffered: existing.messages.length,
        });
      } else {
        // First message — start a new buffer with a debounce timer.
        const buffer = {
          messages: [msg],
          streamIds: [streamId],
          target,
          timestamp,
          nonce,
          timer: setTimeout(
            () => flushMessageBuffer(streamKey, target),
            DEBOUNCE_MS,
          ),
        };
        messageBuffers.set(streamKey, buffer);
        logger.info("WeCom: message buffered (first)", { streamKey, streamId });
      }

      return true;
    }

    // Handle stream refresh - return current stream state
    if (result.stream) {
      const { timestamp, nonce } = result.query;
      const streamId = result.stream.id;

      // Return latest stream state.
      const stream = streamManager.getStream(streamId);

      if (!stream) {
        // Stream already expired or missing.
        logger.warn("Stream not found for refresh", { streamId });
        const streamResponse = webhook.buildStreamResponse(
          streamId,
          "会话已过期",
          true,
          timestamp,
          nonce,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(streamResponse);
        return true;
      }

      // Check if stream should be closed (main response done + idle timeout).
      // This is driven by WeCom client polling, so it's more reliable than setTimeout.
      const meta = streamMeta.get(streamId);
      if (meta?.mainResponseDone && !stream.finished) {
        const idleMs = Date.now() - stream.updatedAt;
        // Keep stream alive a bit longer for delayed subagent/tool follow-up messages.
        if (idleMs > MAIN_RESPONSE_IDLE_CLOSE_MS) {
          logger.info("WeCom: closing stream due to idle timeout", {
            streamId,
            idleMs,
          });
          try {
            await streamManager.finishStream(streamId);
          } catch (err) {
            logger.error("WeCom: failed to finish stream", {
              streamId,
              error: err.message,
            });
          }
        }
      }

      // Return current stream payload.
      const streamResponse = webhook.buildStreamResponse(
        streamId,
        stream.content,
        stream.finished,
        timestamp,
        nonce,
        // Pass msgItem when stream is finished and has images
        stream.finished && stream.msgItem.length > 0
          ? { msgItem: stream.msgItem }
          : {},
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(streamResponse);

      logger.debug("Stream refresh response sent", {
        streamId,
        contentLength: stream.content.length,
        finished: stream.finished,
      });

      // Clean up completed streams after a short delay.
      if (stream.finished) {
        setTimeout(() => {
          streamManager.deleteStream(streamId);
          streamMeta.delete(streamId);
        }, 30 * 1000);
      }

      return true;
    }

    // Handle event
    if (result.event) {
      logger.info("WeCom event received", { event: result.event });

      // Handle enter_chat with an immediate welcome stream.
      if (result.event?.event_type === "enter_chat") {
        const { timestamp, nonce } = result.query;
        const fromUser = result.event?.from?.userid || "";

        // Welcome message body.
        const welcomeMessage = `你好！👋 我是 AI 助手。

你可以使用下面的指令管理会话：
• **/new** - 新建会话（清空上下文）
• **/compact** - 压缩会话（保留上下文摘要）
• **/help** - 查看更多命令

有什么我可以帮你的吗？`;

        // Build and finish stream in a single pass.
        const streamId = `welcome_${crypto.randomUUID()}`;
        streamManager.createStream(streamId);
        streamManager.appendStream(streamId, welcomeMessage);
        await streamManager.finishStream(streamId);

        const streamResponse = webhook.buildStreamResponse(
          streamId,
          welcomeMessage,
          true,
          timestamp,
          nonce,
        );

        logger.info("Sending welcome message", { fromUser, streamId });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(streamResponse);
        return true;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("success");
      return true;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("success");
    return true;
  }

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method Not Allowed");
  return true;
}
