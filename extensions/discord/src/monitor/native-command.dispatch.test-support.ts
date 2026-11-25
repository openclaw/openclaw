import type { dispatchChannelInboundTurn } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { dispatchReplyWithDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

export function nativeCommandContext(
  cfg: OpenClawConfig,
  discordConfig = cfg.channels?.discord ?? {},
) {
  return {
    cfg,
    discordConfig,
    accountId: "default",
    sessionPrefix: "discord:slash",
    threadBindings: createNoopThreadBindingManager("default"),
  };
}

export function forwardNativeCommand(
  dispatchReply: typeof dispatchReplyWithDispatcher,
  requireDelivery: boolean,
): typeof dispatchChannelInboundTurn {
  return async (plan) => {
    const deliver = "deliver" in plan.delivery ? plan.delivery.deliver : undefined;
    const dispatchResult = await dispatchReply({
      ctx: plan.ctxPayload,
      cfg: plan.cfg,
      dispatcherOptions: {
        ...plan.dispatcherOptions,
        deliver: async (payload, info) => {
          if (!deliver) {
            if (requireDelivery) {
              throw new Error("expected core-managed Discord delivery");
            }
            return;
          }
          await deliver(payload, info);
        },
        onError: plan.delivery.onError,
      },
      replyOptions: plan.replyOptions,
    });
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: plan.ctxPayload,
      routeSessionKey: plan.route.sessionKey,
      dispatchResult,
    };
  };
}
