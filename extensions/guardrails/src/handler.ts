import type { BackendFn, EffectiveChannelConfig, Logger } from "./config.js";

/**
 * Event and result types matching PluginHookBeforeDispatchEvent/Context/Result.
 * We define local types to avoid importing from non-public SDK paths.
 */
type BeforeDispatchEvent = {
  content?: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  isGroup?: boolean;
  timestamp?: number;
};

type BeforeDispatchContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  senderId?: string;
};

type BeforeDispatchResult = {
  handled: boolean;
  text?: string;
};

export type GuardrailsHandler = (
  event: BeforeDispatchEvent,
  ctx: BeforeDispatchContext,
) => Promise<BeforeDispatchResult | void>;

/**
 * Effective config subset needed by the handler.
 */
type HandlerConfig = Pick<EffectiveChannelConfig, "fallbackOnError" | "blockMessage">;

/**
 * Create a before_dispatch hook handler from a backend function.
 *
 * Decision mapping:
 *   pass  → { handled: false }
 *   block → { handled: true, text: blockMessage }
 */
export function createGuardrailsHandler(
  backendFn: BackendFn,
  config: HandlerConfig,
  logger: Logger,
): GuardrailsHandler {
  return async (event, ctx): Promise<BeforeDispatchResult> => {
    const text = event.content ?? event.body ?? "";
    const context = {
      sessionKey: ctx.sessionKey ?? event.sessionKey,
      channelId: ctx.channelId ?? event.channel,
      userId: ctx.senderId ?? event.senderId,
    };

    let result;
    try {
      result = await backendFn(text, context);
    } catch (err) {
      logger.warn(`guardrails: check error, fallback=${config.fallbackOnError}: ${String(err)}`);
      if (config.fallbackOnError === "block") {
        return { handled: true, text: config.blockMessage };
      }
      return { handled: false };
    }

    if (result.action === "block") {
      return { handled: true, text: result.blockMessage ?? config.blockMessage };
    }

    return { handled: false };
  };
}
