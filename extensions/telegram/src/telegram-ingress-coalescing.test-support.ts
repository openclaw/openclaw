import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { assert, vi } from "vitest";
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

let runtimeConfig: OpenClawConfig;
let sessionStateDir: string;

export function configureTelegramModuleMocks(stateDir: string, cfg: OpenClawConfig): void {
  runtimeConfig = cfg;
  sessionStateDir = stateDir;
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
  readRuntimeConfig: () => runtimeConfig,
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>()),
  resolveStorePath: (storePath?: string) =>
    storePath ?? path.join(sessionStateDir, "sessions.json"),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  readChannelAllowFromStore: async () => [],
  upsertChannelPairingRequest: async () => ({ code: "PAIRCODE", created: true }),
}));

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueRoutedSystemEvent: () => false,
}));

vi.mock("openclaw/plugin-sdk/models-provider-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/models-provider-runtime")>()),
  buildPreparedModelsProviderData: async () => ({
    byProvider: new Map<string, Set<string>>(),
    providers: [],
    resolvedDefault: { provider: "openai", model: "gpt-test" },
    modelNames: new Map<string, string>(),
    modelCatalog: [],
  }),
}));

vi.mock("openclaw/plugin-sdk/skill-commands-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/skill-commands-runtime")>()),
  prepareSkillCommandsForAgents: async () => [],
}));

vi.mock("./sent-message-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sent-message-cache.js")>()),
  wasSentByBot: () => false,
}));

/** Holds the production forward quiet window; a frozen clock keeps its 1 s delay. */
export function holdForwardWindow() {
  vi.useFakeTimers({ toFake: ["performance"] });
  const timers = holdTelegramMediaTimeouts(1_000);
  return {
    flush: () => {
      const flush = resolveFlushTimerForDelay(timers, 1_000);
      assert(flush, "Expected the forwarded burst's flush timer");
      flush();
    },
    restore: () => timers.mockRestore(),
  };
}

type MessageIds = { updateId: number; messageId: number };

function messageUpdate<T extends object>({ updateId, messageId }: MessageIds, content: T) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_736_380_800 + messageId,
      chat: { id: 111, type: "private" as const, first_name: "Ada" },
      from: { id: 111, is_bot: false, first_name: "Ada" },
      ...content,
    },
  };
}

export function photoUpdate(params: MessageIds & { caption?: string }) {
  return messageUpdate(params, {
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
  });
}

// forward_origin puts the entry on the forward debounce lane (1 s window).
const forwardOrigin = {
  type: "user" as const,
  date: 1_736_300_000,
  sender_user: { id: 555, is_bot: false, first_name: "Origin" },
};

export function forwardedTextUpdate(params: MessageIds & { text: string }) {
  return messageUpdate(params, { text: params.text, forward_origin: forwardOrigin });
}

export function forwardedPhotoUpdate(params: MessageIds) {
  return messageUpdate(params, {
    forward_origin: forwardOrigin,
    photo: photoUpdate(params).message.photo,
  });
}

export function textUpdate(params: MessageIds & { text: string }) {
  return messageUpdate(params, { text: params.text });
}
