import type { WidgetPresenterContext } from "../plugins/plugin-registration.types.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";

/** Project the captured tool invocation into its channel widget delivery context. */
export function createOpenClawWidgetPresenterContext(
  options: OpenClawToolsOptions | undefined,
  deliveryContext: WidgetPresenterContext["deliveryContext"],
): WidgetPresenterContext {
  return {
    messageChannel: options?.agentChannel,
    accountId: options?.agentAccountId,
    deliveryContext,
    nativeChannelId: options?.nativeChannelId,
    currentChannelId: options?.currentChannelId,
    currentMessagingTarget: options?.currentMessagingTarget,
    ...(options?.currentMessageId !== undefined
      ? { currentMessageId: String(options.currentMessageId) }
      : {}),
    sessionKey: options?.runSessionKey ?? options?.agentSessionKey,
  };
}
