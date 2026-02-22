import { WecomCrypto } from "./crypto.js";
import { logger } from "./logger.js";
import { MessageDeduplicator } from "./utils.js";

/**
 * WeCom AI Bot Webhook Handler
 * Based on official demo: https://developer.work.weixin.qq.com/document/path/101039
 *
 * Key differences from legacy mode:
 * - Messages are JSON format, not XML
 * - receiveid is empty string for AI Bot
 * - Response uses stream message format
 */
export class WecomWebhook {
  config;
  crypto;
  deduplicator = new MessageDeduplicator();

  /** Sentinel returned when a message is a duplicate (caller should ACK 200). */
  static DUPLICATE = Symbol.for("wecom.duplicate");

  constructor(config) {
    this.config = config;
    this.crypto = new WecomCrypto(config.token, config.encodingAesKey);
    logger.debug("WecomWebhook initialized (AI Bot mode)");
  }

  // =========================================================================
  // URL Verification (GET request)
  // =========================================================================
  handleVerify(query) {
    const signature = query.msg_signature;
    const timestamp = query.timestamp;
    const nonce = query.nonce;
    const echostr = query.echostr;

    if (!signature || !timestamp || !nonce || !echostr) {
      logger.warn("Missing parameters in verify request", { query });
      return null;
    }

    logger.debug("Handling verify request", { timestamp, nonce });

    const calcSignature = this.crypto.getSignature(timestamp, nonce, echostr);
    if (calcSignature !== signature) {
      logger.error("Signature mismatch in verify", {
        expected: signature,
        calculated: calcSignature,
      });
      return null;
    }

    try {
      const result = this.crypto.decrypt(echostr);
      logger.info("URL verification successful");
      return result.message;
    } catch (e) {
      logger.error("Decrypt failed in verify", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  // =========================================================================
  // Message Handling (POST request)
  // AI Bot uses JSON format, not XML
  // =========================================================================
  async handleMessage(query, body) {
    const signature = query.msg_signature;
    const timestamp = query.timestamp;
    const nonce = query.nonce;

    if (!signature || !timestamp || !nonce) {
      logger.warn("Missing parameters in message request", { query });
      return null;
    }

    // 1. Parse JSON body to get encrypt field
    let encrypt;
    try {
      const jsonBody = JSON.parse(body);
      encrypt = jsonBody.encrypt;
      logger.debug("Parsed request body", { hasEncrypt: !!encrypt });
    } catch (e) {
      logger.error("Failed to parse request body as JSON", {
        error: e instanceof Error ? e.message : String(e),
        body: body.substring(0, 200),
      });
      return null;
    }

    if (!encrypt) {
      logger.error("No encrypt field in body");
      return null;
    }

    // 2. Verify signature
    const calcSignature = this.crypto.getSignature(timestamp, nonce, encrypt);
    if (calcSignature !== signature) {
      logger.error("Signature mismatch in message", {
        expected: signature,
        calculated: calcSignature,
      });
      return null;
    }

    // 3. Decrypt
    let decryptedContent;
    try {
      const result = this.crypto.decrypt(encrypt);
      decryptedContent = result.message;
      logger.debug("Decrypted content", { content: decryptedContent.substring(0, 300) });
    } catch (e) {
      logger.error("Message decrypt failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }

    // 4. Parse decrypted JSON content (AI Bot format)
    let data;
    try {
      data = JSON.parse(decryptedContent);
      logger.debug("Parsed message data", {
        msgtype: data.msgtype,
        keys: Object.keys(data),
        text: JSON.stringify(data.text),
      });
    } catch (e) {
      logger.error("Failed to parse decrypted content as JSON", {
        error: e instanceof Error ? e.message : String(e),
        content: decryptedContent.substring(0, 200),
      });
      return null;
    }

    // 5. Process based on message type
    const msgtype = data.msgtype;

    if (msgtype === "text") {
      // AI Bot format: text.content
      const content = data.text?.content || "";
      const msgId = data.msgid || `msg_${Date.now()}`;
      const fromUser = data.from?.userid || ""; // Note: "userid" not "user_id"
      const responseUrl = data.response_url || "";
      const chatType = data.chattype || "single";
      const chatId = data.chatid || "";
      const aibotId = data.aibotid || "";

      // Parse quoted message metadata when present.
      const quote = data.quote
        ? {
            msgType: data.quote.msgtype,
            content: data.quote.text?.content || data.quote.image?.url || "",
          }
        : null;

      // Check for duplicates
      if (this.deduplicator.isDuplicate(msgId)) {
        logger.debug("Duplicate message ignored", { msgId });
        return WecomWebhook.DUPLICATE;
      }

      logger.info("Received text message", {
        fromUser,
        chatType,
        chatId: chatId || "(private)",
        content: content.substring(0, 50),
      });

      return {
        message: {
          msgId,
          msgType: "text",
          content,
          fromUser,
          chatType,
          chatId,
          aibotId,
          quote,
          responseUrl,
        },
        query: { timestamp, nonce },
      };
    } else if (msgtype === "stream") {
      // Stream continuation request from WeCom
      const streamId = data.stream?.id;
      logger.debug("Received stream refresh request", { streamId });
      return {
        stream: {
          id: streamId,
        },
        query: { timestamp, nonce },
        rawData: data,
      };
    } else if (msgtype === "image") {
      const imageUrl = data.image?.url;
      const msgId = data.msgid || `msg_${Date.now()}`;
      const fromUser = data.from?.userid || "";
      const responseUrl = data.response_url || "";
      const chatType = data.chattype || "single";
      const chatId = data.chatid || "";

      if (this.deduplicator.isDuplicate(msgId)) {
        logger.debug("Duplicate image message ignored", { msgId });
        return WecomWebhook.DUPLICATE;
      }

      logger.info("Received image message", { fromUser, chatType, imageUrl });

      return {
        message: {
          msgId,
          msgType: "image",
          imageUrl,
          fromUser,
          chatType,
          chatId,
          responseUrl,
        },
        query: { timestamp, nonce },
      };
    } else if (msgtype === "voice") {
      // Voice message (single chat only) - WeCom automatically transcribes to text
      const content = data.voice?.content || "";
      const msgId = data.msgid || `msg_${Date.now()}`;
      const fromUser = data.from?.userid || "";
      const responseUrl = data.response_url || "";
      const chatType = data.chattype || "single";
      const chatId = data.chatid || "";

      // Check for duplicates
      if (this.deduplicator.isDuplicate(msgId)) {
        logger.debug("Duplicate voice message ignored", { msgId });
        return WecomWebhook.DUPLICATE;
      }

      // Validate content
      if (!content.trim()) {
        logger.warn("Empty voice message received", { msgId, fromUser });
        return null;
      }

      logger.info("Received voice message (auto-transcribed by WeCom)", {
        fromUser,
        chatType,
        chatId: chatId || "(private)",
        originalType: "voice",
        transcribedLength: content.length,
        preview: content.substring(0, 50),
      });

      // Treat voice as text since WeCom already transcribed it
      return {
        message: {
          msgId,
          msgType: "text",
          content,
          fromUser,
          chatType,
          chatId,
          responseUrl,
        },
        query: { timestamp, nonce },
      };
    } else if (msgtype === "event") {
      logger.info("Received event", { event: data.event });
      return {
        event: data.event,
        query: { timestamp, nonce },
      };
    } else if (msgtype === "mixed") {
      // Mixed message: array of text + image items.
      const msgId = data.msgid || `msg_${Date.now()}`;
      const fromUser = data.from?.userid || "";
      const responseUrl = data.response_url || "";
      const chatType = data.chattype || "single";
      const chatId = data.chatid || "";
      const aibotId = data.aibotid || "";

      if (this.deduplicator.isDuplicate(msgId)) {
        logger.debug("Duplicate mixed message ignored", { msgId });
        return WecomWebhook.DUPLICATE;
      }

      const msgItems = data.mixed?.msg_item || [];
      const textParts = [];
      const imageUrls = [];

      for (const item of msgItems) {
        if (item.msgtype === "text" && item.text?.content) {
          textParts.push(item.text.content);
        } else if (item.msgtype === "image" && item.image?.url) {
          imageUrls.push(item.image.url);
        }
      }

      const content = textParts.join("\n");

      logger.info("Received mixed message", {
        fromUser,
        chatType,
        chatId: chatId || "(private)",
        textParts: textParts.length,
        imageCount: imageUrls.length,
        contentPreview: content.substring(0, 50),
      });

      return {
        message: {
          msgId,
          msgType: "mixed",
          content,
          imageUrls,
          fromUser,
          chatType,
          chatId,
          aibotId,
          responseUrl,
        },
        query: { timestamp, nonce },
      };
    } else if (msgtype === "file") {
      const fileUrl = data.file?.url || "";
      const fileName = data.file?.name || data.file?.filename || "";
      const msgId = data.msgid || `msg_${Date.now()}`;
      const fromUser = data.from?.userid || "";
      const responseUrl = data.response_url || "";
      const chatType = data.chattype || "single";
      const chatId = data.chatid || "";

      if (this.deduplicator.isDuplicate(msgId)) {
        logger.debug("Duplicate file message ignored", { msgId });
        return WecomWebhook.DUPLICATE;
      }

      logger.info("Received file message", {
        fromUser,
        fileName,
        fileUrl: fileUrl.substring(0, 80),
      });

      return {
        message: {
          msgId,
          msgType: "file",
          fileUrl,
          fileName,
          fromUser,
          chatType,
          chatId,
          responseUrl,
        },
        query: { timestamp, nonce },
      };
    } else if (msgtype === "location") {
      const msgId = data.msgid || `msg_${Date.now()}`;
      const fromUser = data.from?.userid || "";
      const responseUrl = data.response_url || "";
      const chatType = data.chattype || "single";
      const chatId = data.chatid || "";
      const latitude = data.location?.latitude || "";
      const longitude = data.location?.longitude || "";
      const name = data.location?.name || data.location?.label || "";

      if (this.deduplicator.isDuplicate(msgId)) {
        logger.debug("Duplicate location message ignored", { msgId });
        return WecomWebhook.DUPLICATE;
      }

      const content = name
        ? `[位置] ${name} (${latitude}, ${longitude})`
        : `[位置] ${latitude}, ${longitude}`;

      logger.info("Received location message", { fromUser, latitude, longitude, name });

      return {
        message: {
          msgId,
          msgType: "text",
          content,
          fromUser,
          chatType,
          chatId,
          responseUrl,
        },
        query: { timestamp, nonce },
      };
    } else if (msgtype === "link") {
      const msgId = data.msgid || `msg_${Date.now()}`;
      const fromUser = data.from?.userid || "";
      const responseUrl = data.response_url || "";
      const chatType = data.chattype || "single";
      const chatId = data.chatid || "";
      const title = data.link?.title || "";
      const description = data.link?.description || "";
      const url = data.link?.url || "";

      if (this.deduplicator.isDuplicate(msgId)) {
        logger.debug("Duplicate link message ignored", { msgId });
        return WecomWebhook.DUPLICATE;
      }

      const parts = [];
      if (title) {
        parts.push(`[链接] ${title}`);
      }
      if (description) {
        parts.push(description);
      }
      if (url) {
        parts.push(url);
      }
      const content = parts.join("\n") || "[链接]";

      logger.info("Received link message", { fromUser, title, url: url.substring(0, 80) });

      return {
        message: {
          msgId,
          msgType: "text",
          content,
          fromUser,
          chatType,
          chatId,
          responseUrl,
        },
        query: { timestamp, nonce },
      };
    } else {
      logger.warn("Unknown message type", { msgtype });
      return null;
    }
  }

  // =========================================================================
  // Build Stream Response (AI Bot format)
  // Supports all core WeCom stream response fields used by this plugin.
  // =========================================================================
  buildStreamResponse(streamId, content, finish, timestamp, nonce, options = {}) {
    const stream = {
      id: streamId,
      finish: finish,
      content: content,
    };

    // Optional mixed media list (images are valid on finished responses).
    if (options.msgItem && options.msgItem.length > 0) {
      stream.msg_item = options.msgItem;
    }

    // Optional feedback tracking id.
    if (options.feedbackId) {
      stream.feedback = { id: options.feedbackId };
    }

    const plain = {
      msgtype: "stream",
      stream: stream,
    };

    const plainStr = JSON.stringify(plain);
    const encrypted = this.crypto.encrypt(plainStr);
    const signature = this.crypto.getSignature(timestamp, nonce, encrypted);

    return JSON.stringify({
      encrypt: encrypted,
      msgsignature: signature,
      timestamp: timestamp,
      nonce: nonce,
    });
  }
}
