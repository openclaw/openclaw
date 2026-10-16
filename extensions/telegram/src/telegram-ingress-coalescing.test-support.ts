import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionEntryAsync } from "openclaw/plugin-sdk/session-store-runtime";
import { vi } from "vitest";
import { telegramDirectDeliveryDepsForTest } from "./bot-delivery-deps.test-support.js";
import {
  holdTelegramMediaTimeouts,
  resolveFlushTimerForDelay,
} from "./bot-media-timers.test-support.js";
import * as telegramSessionRuntime from "./bot-message-context.session.runtime.js";
import type { TelegramBotFixtureMocks } from "./bot-module-mocks.test-support.js";

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

let telegramModuleMocks: TelegramBotFixtureMocks;

export function configureTelegramModuleMocks(stateDir: string, cfg: OpenClawConfig): void {
  telegramModuleMocks = {
    ...telegramDirectDeliveryDepsForTest,
    ...telegramSessionRuntime,
    getSessionEntryAsync,
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
    prepareSkillCommandsForAgents: async () => [],
    wasSentByBot: () => false,
  };
}

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>()),
  // This harness proves the direct-delivery fallback, not durable owner admission.
  deliverStructuredInboundReplyWithMessageSendContext: async () => ({
    status: "unsupported",
    reason: "missing_outbound_handler",
  }),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: (...args: Parameters<TelegramBotFixtureMocks["getRuntimeConfig"]>) =>
    telegramModuleMocks.getRuntimeConfig(...args),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>()),
  resolveStorePath: (...args: Parameters<TelegramBotFixtureMocks["resolveStorePath"]>) =>
    telegramModuleMocks.resolveStorePath(...args),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  readChannelAllowFromStore: (
    ...args: Parameters<TelegramBotFixtureMocks["readChannelAllowFromStore"]>
  ) => telegramModuleMocks.readChannelAllowFromStore(...args),
  upsertChannelPairingRequest: (
    ...args: Parameters<TelegramBotFixtureMocks["upsertChannelPairingRequest"]>
  ) => telegramModuleMocks.upsertChannelPairingRequest(...args),
}));

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueRoutedSystemEvent: (
    ...args: Parameters<TelegramBotFixtureMocks["enqueueRoutedSystemEvent"]>
  ) => telegramModuleMocks.enqueueRoutedSystemEvent(...args),
}));

vi.mock("openclaw/plugin-sdk/models-provider-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/models-provider-runtime")>()),
  buildPreparedModelsProviderData: (
    ...args: Parameters<TelegramBotFixtureMocks["buildModelsProviderData"]>
  ) => telegramModuleMocks.buildModelsProviderData(...args),
}));

vi.mock("openclaw/plugin-sdk/skill-commands-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/skill-commands-runtime")>()),
  prepareSkillCommandsForAgents: (
    ...args: Parameters<TelegramBotFixtureMocks["prepareSkillCommandsForAgents"]>
  ) => telegramModuleMocks.prepareSkillCommandsForAgents(...args),
}));

vi.mock("./sent-message-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sent-message-cache.js")>()),
  wasSentByBot: (...args: Parameters<TelegramBotFixtureMocks["wasSentByBot"]>) =>
    telegramModuleMocks.wasSentByBot(...args),
}));

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
