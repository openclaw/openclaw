import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { Client } from "../internal/discord.js";
import { createReactionDispatchData } from "../internal/gateway-dispatch.js";
import { createDiscordIngressMonitor } from "./ingress.js";
import type { DiscordMessageHandler } from "./listeners.js";
import { runDiscordReactionHandler } from "./listeners.reactions.js";
import { createDiscordMessageDispatcher } from "./message-dispatcher.js";
import { dispatchDiscordReactionConversation } from "./reaction-conversation.js";

type DiscordMessageHandlerParams = Parameters<typeof createDiscordMessageDispatcher>[0];

type DiscordMessageHandlerWithLifecycle = DiscordMessageHandler & {
  deactivate: () => Promise<void>;
};

export function createDiscordMessageHandler(
  params: DiscordMessageHandlerParams & { client: Client },
): DiscordMessageHandlerWithLifecycle {
  const dispatcher = createDiscordMessageDispatcher(params);
  const ingress = createDiscordIngressMonitor({
    ...params,
    dispatchReaction: async (event, lifecycle) => {
      let dispatched = false;
      await runDiscordReactionHandler({
        data: createReactionDispatchData(params.client, event.data),
        client: params.client,
        action: event.action,
        occurrenceId: event.occurrenceId,
        handlerParams: {
          ...params,
          groupPolicy:
            params.discordConfig?.groupPolicy ??
            params.cfg.channels?.defaults?.groupPolicy ??
            "allowlist",
          allowNameMatching: isDangerousNameMatchingEnabled(params.discordConfig),
          groupDmChannels: params.groupDmChannels ?? [],
          allowFrom: params.allowFrom ?? [],
          logger: createSubsystemLogger("discord/reactions"),
        },
        dispatchConversation: async (reaction) => {
          dispatched = await dispatchDiscordReactionConversation(reaction, {
            token: params.token,
            textLimit: params.textLimit,
            lifecycle,
          });
        },
      });
      return dispatched ? { kind: "deferred" } : undefined;
    },
    dispatch: (event, lifecycle) =>
      dispatcher(event, params.client, {
        abortSignal: lifecycle.abortSignal,
        turnAdoptionLifecycle: lifecycle,
      }),
    onDeadLetter: (event, signal) => dispatcher.notifyDeadLetter(event, params.client, signal),
  });
  ingress.start();
  const activeAdmissions = new Set<Promise<void>>();
  let accepting = true;

  const accept = async (rawMessage: Parameters<typeof ingress.accept>[0]) => {
    if (!accepting) {
      return;
    }
    const admission = ingress.accept(rawMessage);
    activeAdmissions.add(admission);
    try {
      await admission;
    } finally {
      activeAdmissions.delete(admission);
    }
  };
  return Object.assign(accept, {
    acceptReaction: accept,
    deactivate: async () => {
      accepting = false;
      await Promise.allSettled(activeAdmissions);
      await dispatcher.deactivate();
      await ingress.stop();
    },
  });
}
