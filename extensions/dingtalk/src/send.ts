import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk";
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
};

export type SendDingTalkMessageResult = {
  messageId: string;
  conversationId: string;
};

/** Default media size limit for DingTalk (20MB) */
const DINGTALK_MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/**
 * Send a message to a DingTalk conversation or user.
 */
export async function sendMessageDingTalk(
  params: SendDingTalkMessageParams,
): Promise<SendDingTalkMessageResult> {
  const { cfg, to, text, mediaUrl } = params;
  const creds = resolveDingTalkCredentials(cfg.channels?.dingtalk);
  if (!creds) {
    throw new Error("DingTalk credentials not configured");
  }

  const tableMode = getDingTalkRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "dingtalk",
  });

  // TODO: Implement actual send logic using DingTalk Stream SDK
  // This is a placeholder implementation
  throw new Error("DingTalk sendMessage not yet implemented");
}
