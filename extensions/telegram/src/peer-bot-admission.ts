// Telegram plugin module serializes peer-bot loop admission across ingress paths.
import type { TelegramDeferredAdmissionCallback } from "./deferred-admission.js";

export type TelegramPeerBotAdmissionCoordinator = {
  reserve: (
    key: string,
    check: (admitted: boolean, cacheMessage?: boolean) => boolean | Promise<boolean>,
  ) => TelegramDeferredAdmissionCallback;
  registerCancellation: (key: string, cancel: () => Promise<void>) => () => void;
  cancel: (key: string) => Promise<void>;
};

export function buildTelegramPeerBotAdmissionKey(params: {
  accountId: string;
  chatId: number;
  threadId?: number;
  senderId: string;
  receiverId?: number;
}): string {
  return `${params.accountId}:${params.chatId}:${params.threadId ?? "main"}:${params.senderId}:${params.receiverId ?? "unknown"}`;
}

export function createTelegramPeerBotAdmissionCoordinator(): TelegramPeerBotAdmissionCoordinator {
  const tails = new Map<string, Promise<void>>();
  const cancellations = new Map<string, Set<() => Promise<void>>>();
  return {
    reserve: (key, check) => {
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const completed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.catch(() => undefined).then(() => completed);
      tails.set(key, tail);
      let result: Promise<boolean> | undefined;
      return (admitted, cacheMessage = true) => {
        result ??= (async () => {
          await previous.catch(() => undefined);
          try {
            return await check(admitted, cacheMessage);
          } finally {
            release();
            if (tails.get(key) === tail) {
              tails.delete(key);
            }
          }
        })();
        return result;
      };
    },
    registerCancellation: (key, cancel) => {
      const callbacks = cancellations.get(key) ?? new Set<() => Promise<void>>();
      callbacks.add(cancel);
      cancellations.set(key, callbacks);
      return () => {
        callbacks.delete(cancel);
        if (callbacks.size === 0) {
          cancellations.delete(key);
        }
      };
    },
    cancel: async (key) => {
      await Promise.allSettled([...(cancellations.get(key) ?? [])].map((cancel) => cancel()));
    },
  };
}
