import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveVkAccount } from "./accounts.js";
import { sendVkMessage } from "./api.js";

export type VkSendOptions = {
  token?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
};

export type VkSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

function resolveSendToken(options: VkSendOptions): string {
  if (options.token) {
    return options.token;
  }
  if (options.cfg) {
    return resolveVkAccount({
      cfg: options.cfg,
      accountId: options.accountId,
    }).token;
  }
  return "";
}

export async function sendVkText(
  peerId: string | number,
  text: string,
  options: VkSendOptions = {},
): Promise<VkSendResult> {
  const token = resolveSendToken(options);
  if (!token) {
    return { ok: false, error: "No VK group token configured" };
  }
  const resolvedPeerId = Number(peerId);
  if (!Number.isFinite(resolvedPeerId) || resolvedPeerId <= 0) {
    return { ok: false, error: "Invalid VK peer id" };
  }
  try {
    const result = await sendVkMessage({
      token,
      peerId: resolvedPeerId,
      text,
    });
    return {
      ok: true,
      messageId: result.messageId,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
