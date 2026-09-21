import type { Bot } from "grammy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import { createTelegramPromptContextProjectionSequence } from "../prompt-context-projection.js";

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));
const { probeVideoDimensions } = vi.hoisted(() => ({
  probeVideoDimensions: vi.fn(),
}));
const triggerInternalHook = vi.hoisted(() => vi.fn(async () => {}));
const recordSentMessage = vi.hoisted(() => vi.fn());
const messageHookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn<(name: string) => boolean>(() => false),
  runMessageSending: vi.fn(),
  runMessageSent: vi.fn(),
}));
export const baseDeliveryParams = {
  chatId: "123",
  token: "tok",
  replyToMode: "off",
  textLimit: 4000,
} as const;
type RuntimeStub = Pick<RuntimeEnv, "error" | "log" | "exit">;

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMedia(...args),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    probeVideoDimensions,
  };
});

vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>();
  return {
    ...actual,
    triggerInternalHook,
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    getGlobalHookRunner: () => messageHookRunner,
  };
});

vi.mock("../sent-message-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sent-message-cache.js")>();
  return { ...actual, recordSentMessage };
});

vi.resetModules();
export const { deliverReplies, deliverStructuredReplies } = await import("./delivery.js");
export const { PlatformMessageNotDispatchedError } =
  await import("openclaw/plugin-sdk/error-runtime");

vi.mock("grammy", () => ({
  API_CONSTANTS: {
    DEFAULT_UPDATE_TYPES: ["message"],
    ALL_UPDATE_TYPES: ["message"],
  },
  InputFile: class {
    constructor(
      public buffer: Buffer,
      public filename?: string,
    ) {}
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
}));

export const { TelegramRequestNotStartedError } = await import("../network-errors.js");

export function createRuntime(withLog = true): RuntimeStub {
  return {
    error: vi.fn(),
    log: withLog ? vi.fn() : vi.fn(),
    exit: vi.fn(),
  };
}

export function createBot(api: Record<string, unknown> = {}): Bot {
  const raw = {
    sendRichMessage: vi.fn(
      (params: {
        chat_id: string | number;
        rich_message: {
          blocks?: unknown[];
          markdown?: string;
          html?: string;
          skip_entity_detection?: boolean;
        };
        [key: string]: unknown;
      }) => {
        const sendMessage = api.sendMessage;
        if (typeof sendMessage !== "function") {
          throw new Error("sendMessage mock missing");
        }
        const { chat_id, rich_message, ...richParams } = params;
        const sendParams: Record<string, unknown> = {
          parse_mode: "HTML",
          ...(rich_message.skip_entity_detection === true ? { skip_entity_detection: true } : {}),
          ...richParams,
        };
        const text = Array.isArray(rich_message.blocks)
          ? rich_message.blocks
              .map((block) => {
                const blockText = (block as { text?: unknown }).text;
                return typeof blockText === "string" ? blockText : "";
              })
              .join("\n")
          : (rich_message.markdown ?? rich_message.html ?? "");
        const replyParameters = sendParams.reply_parameters;
        if (
          replyParameters &&
          typeof replyParameters === "object" &&
          !("quote" in replyParameters) &&
          typeof (replyParameters as { message_id?: unknown }).message_id === "number"
        ) {
          sendParams.reply_to_message_id = (replyParameters as { message_id: number }).message_id;
          sendParams.allow_sending_without_reply = true;
          delete sendParams.reply_parameters;
        }
        const options = sendParams;
        return sendMessage(chat_id, text, options);
      },
    ),
  };
  return { api: { ...api, raw } } as unknown as Bot;
}

export function mockMediaLoad(fileName: string, contentType: string, data: string) {
  loadWebMedia.mockResolvedValueOnce({
    buffer: Buffer.from(data),
    contentType,
    fileName,
  });
}

export function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex: number, argIndex: number) {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

export function firstMockCallArg(mock: ReturnType<typeof vi.fn>, argIndex: number) {
  return mockCallArg(mock, 0, argIndex);
}

export function resetDeliveryMocks() {
  loadWebMedia.mockClear();
  probeVideoDimensions.mockReset();
  probeVideoDimensions.mockResolvedValue(undefined);
  triggerInternalHook.mockReset();
  recordSentMessage.mockReset();
  messageHookRunner.hasHooks.mockReset();
  messageHookRunner.hasHooks.mockReturnValue(false);
  messageHookRunner.runMessageSending.mockReset();
  messageHookRunner.runMessageSent.mockReset();
}

export {
  loadWebMedia,
  messageHookRunner,
  probeVideoDimensions,
  recordSentMessage,
  triggerInternalHook,
};

export function createObservedPromptContextSequence(
  record: (value: unknown) => void,
  source?: { transcriptMessageId: string },
) {
  return createTelegramPromptContextProjectionSequence({
    ...(source ? { source } : {}),
    record: async (value) => {
      record(value);
      return true;
    },
  });
}
