import crypto from "node:crypto";
import type { ReasoningStreamSinkConfig } from "openclaw/plugin-sdk/config-types";

const DEFAULT_TIMEOUT_MS = 5_000;

export type ReasoningStreamSinkContext = {
  chatId: string;
  threadId?: number;
  accountId?: string;
  sessionKey?: string;
};

export type ReasoningStreamSinkStartEvent = {
  event: "reasoning_start";
  streamId: string;
  chatId: string;
  threadId?: number;
  accountId?: string;
  sessionKey?: string;
  timestamp: number;
};

export type ReasoningStreamSinkTokenEvent = {
  event: "reasoning_stream";
  streamId: string;
  text: string;
  timestamp: number;
};

export type ReasoningStreamSinkEndEvent = {
  event: "reasoning_end";
  streamId: string;
  timestamp: number;
};

export type ReasoningStreamSinkEvent =
  | ReasoningStreamSinkStartEvent
  | ReasoningStreamSinkTokenEvent
  | ReasoningStreamSinkEndEvent;

export type ReasoningStreamSinkHandle = {
  onToken(text: string): void;
  onEnd(): void;
};

export function createReasoningStreamSink(params: {
  config: ReasoningStreamSinkConfig;
  context: ReasoningStreamSinkContext;
  resolvedSecret?: string;
  resolvedHeaders?: Record<string, string>;
  warn?: (message: string) => void;
}): ReasoningStreamSinkHandle {
  const { config, context, resolvedSecret, resolvedHeaders, warn } = params;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const streamId = crypto.randomBytes(4).toString("hex");
  let started = false;
  let lastSnapshot = "";

  function post(payload: ReasoningStreamSinkEvent): void {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...resolvedHeaders,
    };
    if (resolvedSecret) {
      const sig = crypto.createHmac("sha256", resolvedSecret).update(body).digest("hex");
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
  }

  return {
    onToken(text: string): void {
      const delta = text.startsWith(lastSnapshot) ? text.slice(lastSnapshot.length) : text;
      lastSnapshot = text;
      if (!delta) {
        return;
      }
      if (!started) {
        started = true;
        post({
          event: "reasoning_start",
          streamId,
          chatId: context.chatId,
          threadId: context.threadId,
          accountId: context.accountId,
          sessionKey: context.sessionKey,
          timestamp: Date.now(),
        });
      }
      post({
        event: "reasoning_stream",
        streamId,
        text: delta,
        timestamp: Date.now(),
      });
    },
    onEnd(): void {
      if (!started) {
        return;
      }
      post({
        event: "reasoning_end",
        streamId,
        timestamp: Date.now(),
      });
    },
  };
}
