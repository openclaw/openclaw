import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveTuituiAccount } from "./accounts.js";
import { sendTuituiMessage } from "./api.js";

export type TuituiSendOptions = {
  appId?: string;
  secret?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
};

export type TuituiSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

function resolveSendContext(options: TuituiSendOptions) {
  if (options.cfg) {
    const account = resolveTuituiAccount({
      cfg: options.cfg,
      accountId: options.accountId,
    });
    return { appId: account.appId, secret: account.secret };
  }
  return {
    appId: options.appId ?? "",
    secret: options.secret ?? "",
  };
}

const TUITUI_TEXT_LIMIT = 50000;

export async function sendMessageTuitui(
  to: string,
  text: string,
  options: TuituiSendOptions = {},
): Promise<TuituiSendResult> {
  const { appId, secret } = resolveSendContext(options);

  if (!appId || !secret) {
    return { ok: false, error: "推推未配置 appId 或 secret" };
  }

  if (!to?.trim()) {
    return { ok: false, error: "未提供接收目标 (to)" };
  }

  return sendTuituiMessage({
    appId,
    secret,
    to: to.trim(),
    content: text.slice(0, TUITUI_TEXT_LIMIT),
  });
}
