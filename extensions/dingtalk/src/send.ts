import axios from "axios";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getDingTalkRuntime } from "./runtime.js";
import { resolveDingTalkCredentials } from "./token.js";

export type SendDingTalkMessageParams = {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  /** Message text */
  text: string;
  /** Optional media URL */
  mediaUrl?: string;
  /** Optional sessionWebhook (from incoming message) */
  sessionWebhook?: string;
};

export type SendDingTalkMessageResult = {
  messageId: string;
  conversationId: string;
};

/** Default media size limit for DingTalk (20MB) */
const DINGTALK_MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/**
 * Get DingTalk access token.
 */
async function getDingTalkAccessToken(appKey: string, appSecret: string): Promise<string> {
  const response = await axios.get("https://oapi.dingtalk.com/gettoken", {
    params: {
      appkey: appKey,
      appsecret: appSecret,
    },
  });

  if (response.data?.access_token) {
    return response.data.access_token;
  }
  throw new Error("Failed to get DingTalk access token");
}

/**
 * Send a message to a DingTalk conversation or user.
 *
 * Note: In Stream mode, we can use sessionWebhook from incoming messages to reply.
 * For proactive messages, we need to use DingTalk OpenAPI (which requires conversation ID).
 * This implementation currently supports replying via sessionWebhook.
 */
export async function sendMessageDingTalk(
  params: SendDingTalkMessageParams,
): Promise<SendDingTalkMessageResult> {
  const { cfg, to, text, mediaUrl, sessionWebhook } = params;
  const creds = resolveDingTalkCredentials(cfg.channels?.dingtalk);
  if (!creds) {
    throw new Error("DingTalk credentials not configured");
  }

  const core = getDingTalkRuntime();
  const log = core.logging.getChildLogger({ name: "dingtalk" });

  // If we have a sessionWebhook, use it to send the message (reply mode)
  if (sessionWebhook) {
    try {
      const accessToken = await getDingTalkAccessToken(creds.appKey, creds.appSecret);

      const messageBody: {
        msgtype: string;
        text?: { content: string };
        at?: { atUserIds?: string[]; isAtAll: boolean };
      } = {
        msgtype: "text",
        text: {
          content: text,
        },
      };

      const response = await axios({
        url: sessionWebhook,
        method: "POST",
        responseType: "json",
        data: messageBody,
        headers: {
          "x-acs-dingtalk-access-token": accessToken,
        },
      });

      log.debug("sent message via sessionWebhook", { to, messageId: response.data?.messageId });

      return {
        messageId: response.data?.messageId || `dt-${Date.now()}`,
        conversationId: to,
      };
    } catch (err) {
      log.error("failed to send message via sessionWebhook", {
        error: String(err),
        to,
      });
      throw new Error(`Failed to send DingTalk message: ${String(err)}`);
    }
  }

  // TODO: Implement proactive message sending via DingTalk OpenAPI
  // This requires:
  // 1. Getting conversation ID from user ID (if sending to DM)
  // 2. Using DingTalk OpenAPI to send messages
  // 3. Handling group messages differently
  throw new Error(
    "DingTalk proactive message sending not yet implemented. Use sessionWebhook for replies.",
  );
}
