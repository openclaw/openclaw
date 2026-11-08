import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { TelegramChannelConfig } from "./bot.config.test-support.js";

export const openDirect = (): TelegramChannelConfig => ({ dmPolicy: "open", allowFrom: ["*"] });

export function groupCallbackConfig(): TelegramChannelConfig {
  return {
    dmPolicy: "open",
    capabilities: { inlineButtons: "group" },
    groupPolicy: "open",
    groups: { "*": { requireMention: false } },
  };
}
export function questionCallbackConfig(): TelegramChannelConfig {
  return {
    ...groupCallbackConfig(),
    allowFrom: ["9"],
    capabilities: { inlineButtons: "all" },
    groups: { "*": { requireMention: false, allowFrom: ["9"] } },
  };
}

export const ada = { id: 9, is_bot: false, first_name: "Ada", username: "ada_bot" };
export const botIdentity = {
  id: 999,
  is_bot: true,
  first_name: "OpenClaw",
  username: "openclaw_bot",
};
export function inboundMessage(overrides: Record<string, unknown> = {}) {
  return {
    chat: { id: 7, type: "private" },
    from: ada,
    message_id: 103,
    date: 1736380800,
    ...overrides,
  };
}

export function photoReply(chat: Record<string, unknown>) {
  return inboundMessage({
    chat,
    message_id: 101,
    date: 1736380700,
    from: { id: 999, is_bot: true, first_name: "OpenClaw" },
    text: "Done, here is the image",
    photo: [
      { file_id: "generated-photo-1", file_unique_id: "generated-photo-u1", width: 1, height: 1 },
    ],
  });
}

export function createReplyPhotoMessage(text: string) {
  return {
    chat: { id: 7, type: "private" },
    text,
    date: 1_736_380_800,
    reply_to_message: {
      chat: { id: 7, type: "private", first_name: "Ada" },
      date: 1_736_380_700,
      message_id: 9001,
      photo: [{ file_id: "reply-photo-1" }],
      from: { first_name: "Ada" },
    },
  };
}

export type TelegramTestContext = Record<string, unknown>;
export type TelegramTestMiddleware = (
  ctx: TelegramTestContext,
  next: () => Promise<void>,
) => Promise<void> | void;

type MiddlewareUseSpy = { mock: { calls: unknown[][] } };

type ChannelInboundModule = typeof import("openclaw/plugin-sdk/channel-inbound");
type ChannelInboundRunParams = Parameters<ChannelInboundModule["runChannelInboundEvent"]>[0];
type BufferedReplyDispatcher =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;

export function makeTelegramKeyedStoreTestMock<Value>(
  overrides: Partial<PluginStateKeyedStore<Value, 2>> = {},
): PluginStateKeyedStore<Value, 2> {
  const unexpectedCall = async (operation: string): Promise<never> => {
    throw new Error(`unexpected Telegram keyed-store ${operation} call`);
  };
  return {
    observe: () => unexpectedCall("observe"),
    compareAndApply: () => unexpectedCall("compareAndApply"),
    register: () => unexpectedCall("register"),
    registerIfAbsent: () => unexpectedCall("registerIfAbsent"),
    lookup: () => unexpectedCall("lookup"),
    lookupMany: () => unexpectedCall("lookupMany"),
    consume: () => unexpectedCall("consume"),
    delete: () => unexpectedCall("delete"),
    deleteIfEqual: () => unexpectedCall("deleteIfEqual"),
    entries: () => unexpectedCall("entries"),
    entriesInKeyRange: () => unexpectedCall("entriesInKeyRange"),
    moveEntriesFrom: () => unexpectedCall("moveEntriesFrom"),
    count: () => unexpectedCall("count"),
    clear: () => unexpectedCall("clear"),
    ...overrides,
  };
}

export async function runTelegramChannelInboundEventWithHarness(
  actual: ChannelInboundModule,
  params: ChannelInboundRunParams,
  dispatchReply: BufferedReplyDispatcher,
) {
  const resolveTurn = params.adapter.resolveTurn;
  return await actual.runChannelInboundEvent({
    ...params,
    adapter: {
      ...params.adapter,
      resolveTurn: async (input, eventClass, preflight) => {
        const resolved = await resolveTurn(input, eventClass, preflight);
        if (!("route" in resolved) || "runDispatch" in resolved) {
          return resolved;
        }
        const plan =
          resolved as unknown as import("openclaw/plugin-sdk/channel-inbound").ChannelInboundTurnPlan<"provider_message_sending">;
        return {
          ...plan,
          runDispatch: async () =>
            await dispatchReply({
              ctx: plan.ctxPayload,
              cfg: plan.cfg,
              dispatcherOptions: {
                ...plan.dispatcherOptions,
                deliver: (payload, info) =>
                  plan.delivery.deliverWithProviderMessageSending(payload, {
                    ...info,
                    onPlatformSendDispatch: info.onPlatformSendDispatch ?? (async () => undefined),
                    assertPlatformSendAuthorized:
                      info.assertPlatformSendAuthorized ?? (() => undefined),
                  }),
                onError: plan.delivery.onError,
              },
              toolsAllow: plan.toolsAllow,
              replyOptions: plan.replyOptions,
              replyResolver: plan.replyResolver,
            }),
          runDispatchLifecycle: {
            turnAdoptionLifecycle: params.turnAdoptionLifecycle,
            onDispatchSkipped: () => params.turnAdoptionLifecycle?.onAbandoned?.(),
          },
        };
      },
    },
  });
}

export function createTelegramCallbackContext(params: {
  id: string;
  data: string;
  from?: Record<string, unknown>;
  message?: Record<string, unknown>;
  updateId?: number;
  update?: Record<string, unknown>;
}): TelegramTestContext {
  const callbackQuery = {
    id: params.id,
    data: params.data,
    from: params.from ?? { id: 9, first_name: "Ada", username: "ada_bot" },
    message: {
      chat: { id: 1234, type: "private" },
      date: 1_736_380_800,
      message_id: 10,
      ...params.message,
    },
  };
  return {
    ...(params.update
      ? { update: params.update }
      : params.updateId === undefined
        ? {}
        : { update: { update_id: params.updateId, callback_query: callbackQuery } }),
    callbackQuery,
    me: { username: "openclaw_bot" },
    getFile: async () => ({ download: async () => new Uint8Array() }),
  };
}

export async function runTelegramTestMiddlewareChain(
  middlewareUseSpy: MiddlewareUseSpy,
  ctx: TelegramTestContext,
  finalHandler: (ctx: TelegramTestContext) => Promise<void>,
): Promise<void> {
  const middlewares = middlewareUseSpy.mock.calls
    .map((call) => call[0])
    .filter((fn): fn is TelegramTestMiddleware => typeof fn === "function");
  let index = -1;
  const dispatch = async (nextIndex: number): Promise<void> => {
    if (nextIndex <= index) {
      throw new Error("middleware dispatch called multiple times");
    }
    index = nextIndex;
    const middleware = middlewares[nextIndex];
    await (middleware ? middleware(ctx, async () => dispatch(nextIndex + 1)) : finalHandler(ctx));
  };
  await dispatch(0);
}
