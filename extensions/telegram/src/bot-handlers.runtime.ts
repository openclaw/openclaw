import { createTelegramCallbackRouter } from "./bot-handlers.callback-router.js";
import { createTelegramEventBindings } from "./bot-handlers.event-bindings.js";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import {
  createTelegramInboundPipeline,
  registerTelegramInboundHandlers,
} from "./bot-handlers.inbound-pipeline.js";
import { createTelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type {
  RegisterTelegramHandlerParams,
  TelegramNativeCommandCallbackDispatcher,
  TelegramPluginCommandContinuation,
} from "./bot-handlers.types.js";
import { createTelegramWidgetQueryRouter } from "./widgets/widget-query-router.js";

export const createTelegramHandlers = (
  params: Omit<RegisterTelegramHandlerParams, "nativeCommandCallbackDispatcher">,
) => {
  const message = createTelegramMessagePipeline(params);
  const authorization = createTelegramHandlerAuthorization(params);
  const pipelineContext = { params, message, authorization };
  const inboundPipeline = createTelegramInboundPipeline(pipelineContext);
  // Same synthetic native-command turn the callback router uses for command buttons.
  const continuePluginCommandTurn: TelegramPluginCommandContinuation = async (turn) => {
    await message.processMessageWithReplyChain({
      ctx: turn.ctx,
      msg: turn.ctx.message,
      allMedia: [],
      storeAllowFrom: turn.storeAllowFrom,
      options: {
        threadSpec: turn.threadSpec,
        commandSource: "native",
        forceWasMentioned: true,
        pluginCommandDispatch: turn.pluginCommandDispatch,
      },
    });
  };
  return {
    continuePluginCommandTurn,
    register(nativeCommandCallbackDispatcher?: TelegramNativeCommandCallbackDispatcher) {
      const callbackRouter = createTelegramCallbackRouter({
        params: { ...params, nativeCommandCallbackDispatcher },
        message,
        authorization,
      });
      const eventBindings = createTelegramEventBindings(pipelineContext);
      eventBindings.registerChatMembership();
      eventBindings.registerReaction();
      eventBindings.registerPolls();
      params.bot.on("callback_query", async (ctx) => {
        await callbackRouter.route(ctx);
      });
      const widgetQueryRouter = createTelegramWidgetQueryRouter({ params, message, authorization });
      params.bot.use((ctx, next) => widgetQueryRouter.route(ctx, next));
      eventBindings.registerMigration();
      registerTelegramInboundHandlers({ bot: params.bot, pipeline: inboundPipeline });
    },
  };
};
