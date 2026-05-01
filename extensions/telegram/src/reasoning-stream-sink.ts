import crypto from "node:crypto";
import type { ReasoningStreamSinkConfig } from "openclaw/plugin-sdk/config-types";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";

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
  const policy = ssrfPolicyFromHttpBaseUrlAllowedHostname(config.url);
  let started = false;
  let lastSnapshot = "";
  let chain: Promise<void> = Promise.resolve();

  async function post(payload: ReasoningStreamSinkEvent): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...resolvedHeaders,
    };
    if (resolvedSecret) {
      const sig = crypto.createHmac("sha256", resolvedSecret).update(body).digest("hex");
      headers["X-Openclaw-Signature"] = `sha256=${sig}`;
    }
    let release: (() => Promise<void>) | undefined;
    try {
      const result = await fetchWithSsrFGuard({
        url: config.url,
        init: { method: "POST", headers, body },
        timeoutMs,
        policy,
      });
      release = result.release;
      if (!result.response.ok) {
        warn?.(
          `reasoning stream sink: unexpected status ${result.response.status} from ${config.url}`,
        );
      }
    } catch (err: unknown) {
      warn?.(`reasoning stream sink: POST failed: ${String(err)}`);
    } finally {
      await release?.();
    }
  }

  function enqueue(payload: ReasoningStreamSinkEvent): void {
    chain = chain.then(() => post(payload)).catch(() => undefined);
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
        enqueue({
          event: "reasoning_start",
          streamId,
          chatId: context.chatId,
          threadId: context.threadId,
          accountId: context.accountId,
          sessionKey: context.sessionKey,
          timestamp: Date.now(),
        });
      }
      enqueue({
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
      enqueue({
        event: "reasoning_end",
        streamId,
        timestamp: Date.now(),
      });
    },
  };
}
