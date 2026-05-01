import crypto from "node:crypto";
import type { TelegramReasoningStreamSinkConfig } from "openclaw/plugin-sdk/config-types";

const DEFAULT_TIMEOUT_MS = 5_000;

export type ReasoningStreamSinkContext = {
  chatId: string;
  threadId?: number;
  accountId?: string;
};

export type ReasoningStreamSinkEvent = {
  event: "reasoning_stream";
  text: string;
  chatId: string;
  threadId?: number;
  accountId?: string;
  timestamp: number;
};

export function createReasoningStreamSink(params: {
  config: TelegramReasoningStreamSinkConfig;
  context: ReasoningStreamSinkContext;
  warn?: (message: string) => void;
}): (text: string) => void {
  const { config, context, warn } = params;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return (text: string) => {
    if (!text) {
      return;
    }
    const payload: ReasoningStreamSinkEvent = {
      event: "reasoning_stream",
      text,
      chatId: context.chatId,
      threadId: context.threadId,
      accountId: context.accountId,
      timestamp: Date.now(),
    };
    const body = JSON.stringify(payload);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };
    if (config.secret) {
      const sig = crypto.createHmac("sha256", config.secret).update(body).digest("hex");
      headers["X-Openclaw-Signature"] = `sha256=${sig}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(config.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) {
          warn?.(`reasoning stream sink: unexpected status ${res.status} from ${config.url}`);
        }
      })
      .catch((err: unknown) => {
        warn?.(`reasoning stream sink: POST failed: ${String(err)}`);
      })
      .finally(() => {
        clearTimeout(timer);
      });
  };
}
