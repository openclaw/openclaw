import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAMessage,
  WAPresence,
} from "baileys";
import { captureEffectAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import {
  parseStrictPositiveInteger,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";

export type WhatsAppSocketTimingOptions = {
  keepAliveIntervalMs?: number;
  connectTimeoutMs?: number;
  defaultQueryTimeoutMs?: number;
};

export type WhatsAppSocketOperationAdapter = {
  sendMessage: (
    jid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ) => Promise<WAMessage | undefined>;
  sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
};

type WhatsAppSocketOperationTimeoutHooks = {
  assertCurrent?: () => void;
  onSendMessageTimeout?: (params: { jid: string; promise: Promise<WAMessage | undefined> }) => void;
};

const socketSendMessageQueues = new WeakMap<WhatsAppSocketOperationAdapter, KeyedAsyncQueue>();

export const DEFAULT_WHATSAPP_SOCKET_TIMING: Required<WhatsAppSocketTimingOptions> = {
  keepAliveIntervalMs: 25_000,
  connectTimeoutMs: 60_000,
  defaultQueryTimeoutMs: 60_000,
};

class WhatsAppSocketOperationTimeoutError extends Error {
  readonly deliveryState = "unknown";

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`WhatsApp socket ${operation} timed out after ${timeoutMs}ms; delivery state is unknown`);
    this.name = "WhatsAppSocketOperationTimeoutError";
  }
}

export function resolveWhatsAppSocketTiming(
  overrides?: WhatsAppSocketTimingOptions,
): Required<WhatsAppSocketTimingOptions> {
  return {
    keepAliveIntervalMs:
      parseStrictPositiveInteger(overrides?.keepAliveIntervalMs) ??
      DEFAULT_WHATSAPP_SOCKET_TIMING.keepAliveIntervalMs,
    connectTimeoutMs:
      parseStrictPositiveInteger(overrides?.connectTimeoutMs) ??
      DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs,
    defaultQueryTimeoutMs:
      parseStrictPositiveInteger(overrides?.defaultQueryTimeoutMs) ??
      DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
  };
}

export function isWhatsAppSocketOperationTimeoutError(
  error: unknown,
): error is WhatsAppSocketOperationTimeoutError {
  return error instanceof WhatsAppSocketOperationTimeoutError;
}

export function resolveWhatsAppSocketOperationTimeoutMs(timeoutMs: number): number {
  return resolveTimerTimeoutMs(timeoutMs, DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs);
}

function runSerializedSocketSendMessage<T>(
  sock: WhatsAppSocketOperationAdapter,
  run: () => Promise<T>,
): Promise<T> {
  // Adapter instances are short-lived, so key the FIFO by the raw socket. A
  // bounded send releases the queue after timeout to avoid wedging later work.
  let queue = socketSendMessageQueues.get(sock);
  if (!queue) {
    queue = new KeyedAsyncQueue();
    socketSendMessageQueues.set(sock, queue);
  }
  return queue.enqueue("sendMessage", run);
}

export async function withWhatsAppSocketOperationTimeout<T>(
  operation: string,
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  const resolvedTimeoutMs = resolveWhatsAppSocketOperationTimeoutMs(timeoutMs);
  return await raceWithTimeout(
    promise,
    resolvedTimeoutMs,
    () => {
      onTimeout?.();
      throw new WhatsAppSocketOperationTimeoutError(operation, resolvedTimeoutMs);
    },
    { ref: false },
  );
}

export function createWhatsAppSocketOperationTimeoutAdapter(
  sock: WhatsAppSocketOperationAdapter,
  timeoutMs: number,
  hooks?: WhatsAppSocketOperationTimeoutHooks,
): WhatsAppSocketOperationAdapter {
  const operationTimeoutMs = resolveWhatsAppSocketOperationTimeoutMs(timeoutMs);
  const runOperation = <T>(
    operation: keyof WhatsAppSocketOperationAdapter,
    send: () => Promise<T>,
    onTimeout?: (promise: Promise<T>) => void,
  ) => {
    const effect = captureEffectAuthority();
    const run = () => {
      let active = true;
      const promise = effect.initiate(() => {
        if (!active) {
          throw new WhatsAppSocketOperationTimeoutError(operation, operationTimeoutMs);
        }
        hooks?.assertCurrent?.();
        return send();
      });
      return withWhatsAppSocketOperationTimeout(operation, promise, operationTimeoutMs, () => {
        active = false;
        onTimeout?.(promise);
      });
    };
    return operation === "sendMessage" ? runSerializedSocketSendMessage(sock, run) : run();
  };
  return {
    sendMessage: (jid, content, options) =>
      runOperation(
        "sendMessage",
        () => (options ? sock.sendMessage(jid, content, options) : sock.sendMessage(jid, content)),
        (promise) => hooks?.onSendMessageTimeout?.({ jid, promise }),
      ),
    sendPresenceUpdate: (presence, jid) =>
      runOperation("sendPresenceUpdate", () =>
        jid === undefined
          ? sock.sendPresenceUpdate(presence)
          : sock.sendPresenceUpdate(presence, jid),
      ),
  };
}
