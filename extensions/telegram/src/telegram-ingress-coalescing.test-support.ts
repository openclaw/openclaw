import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  holdTelegramMediaTimeouts,
  resolveFlushTimerForDelay,
} from "./bot-media-timers.test-support.js";

export function createBotApiTransport() {
  let getFileCall = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (url.includes("/getFile")) {
      getFileCall += 1;
      return Response.json({
        ok: true,
        result: {
          file_id: `photo-${getFileCall}`,
          file_unique_id: `unique-${getFileCall}`,
          file_size: 4,
          file_path: `photos/photo-${getFileCall}.jpg`,
        },
      });
    }
    return Response.json({ ok: true, result: true });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, sourceFetch: fetchImpl, close: async () => {} };
}

export function createTelegramDeps(stateDir: string, cfg: OpenClawConfig): TelegramBotDeps {
  return {
    getRuntimeConfig: () => cfg,
    resolveStorePath: (storePath?: string) => storePath ?? path.join(stateDir, "sessions.json"),
    readChannelAllowFromStore: async () => [],
    upsertChannelPairingRequest: async () => ({ code: "PAIRCODE", created: true }),
    enqueueRoutedSystemEvent: () => false,
    dispatchReplyWithBufferedBlockDispatcher: async () => ({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    }),
    buildModelsProviderData: async () => ({
      byProvider: new Map<string, Set<string>>(),
      providers: [],
      resolvedDefault: { provider: "openai", model: "gpt-test" },
      modelNames: new Map<string, string>(),
      modelCatalog: [],
    }),
    listSkillCommandsForAgents: () => [],
    wasSentByBot: () => false,
  } as TelegramBotDeps;
}

/** Holds the production forward quiet window; a frozen clock keeps its 1 s delay. */
export function holdForwardWindow() {
  vi.useFakeTimers({ toFake: ["performance"] });
  const timers = holdTelegramMediaTimeouts(1_000);
  return {
    flush: () => {
      const flush = resolveFlushTimerForDelay(timers, 1_000);
      if (!flush) {
        throw new Error("Expected the forwarded burst's flush timer");
      }
      flush();
    },
    restore: () => timers.mockRestore(),
  };
}

export function photoUpdate(params: { updateId: number; messageId: number; caption?: string }) {
  return {
    update_id: params.updateId,
    message: {
      message_id: params.messageId,
      date: 1_736_380_800 + params.messageId,
      chat: { id: 111, type: "private" as const, first_name: "Ada" },
      from: { id: 111, is_bot: false, first_name: "Ada" },
      media_group_id: "album-115325",
      ...(params.caption ? { caption: params.caption } : {}),
      photo: [
        {
          file_id: `photo-${params.messageId}`,
          file_unique_id: `unique-${params.messageId}`,
          width: 100,
          height: 100,
          file_size: 4,
        },
      ],
    },
  };
}

// forward_origin puts the entry on the forward debounce lane (1 s window).
const forwardOrigin = {
  type: "user" as const,
  date: 1_736_300_000,
  sender_user: { id: 555, is_bot: false, first_name: "Origin" },
};

export function forwardedTextUpdate(params: { updateId: number; messageId: number; text: string }) {
  return {
    update_id: params.updateId,
    message: {
      message_id: params.messageId,
      date: 1_736_380_800 + params.messageId,
      chat: { id: 111, type: "private" as const, first_name: "Ada" },
      from: { id: 111, is_bot: false, first_name: "Ada" },
      forward_origin: forwardOrigin,
      text: params.text,
    },
  };
}

export function forwardedPhotoUpdate(params: { updateId: number; messageId: number }) {
  return {
    update_id: params.updateId,
    message: {
      message_id: params.messageId,
      date: 1_736_380_800 + params.messageId,
      chat: { id: 111, type: "private" as const, first_name: "Ada" },
      from: { id: 111, is_bot: false, first_name: "Ada" },
      forward_origin: forwardOrigin,
      photo: photoUpdate(params).message.photo,
    },
  };
}

export function textUpdate(params: { updateId: number; messageId: number; text: string }) {
  return {
    update_id: params.updateId,
    message: {
      message_id: params.messageId,
      date: 1_736_380_800 + params.messageId,
      chat: { id: 111, type: "private" as const, first_name: "Ada" },
      from: { id: 111, is_bot: false, first_name: "Ada" },
      text: params.text,
    },
  };
}
