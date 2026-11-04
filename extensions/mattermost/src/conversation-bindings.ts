import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ResolvedMattermostAccount } from "./mattermost/accounts.js";
import { normalizeMattermostMessagingTarget } from "./normalize.js";
import { defaultTopLevelPlacement } from "./thread-binding-api.js";

const loadMattermostChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

const setLifecycleBySessionKey = async (
  params: Parameters<
    typeof import("./mattermost/thread-bindings.js").setMattermostThreadBindingLifecycleBySessionKeyAsync
  >[0],
) =>
  (await loadMattermostChannelRuntime()).setMattermostThreadBindingLifecycleBySessionKeyAsync(
    params,
  );

/** Thread-bound sessions: child threads only, owned by the monitor's binding adapter. */
export const mattermostConversationBindings: NonNullable<
  ChannelPlugin<ResolvedMattermostAccount>["conversationBindings"]
> = {
  bindingStore: "adapter",
  defaultTopLevelPlacement,
  setIdleTimeoutBySessionKeyAsync: setLifecycleBySessionKey,
  setMaxAgeBySessionKeyAsync: setLifecycleBySessionKey,
};

/** A bound thread is its root post id under the channel id. */
export function resolveMattermostConversationDeliveryTarget(params: {
  conversationId: string;
  parentConversationId?: string;
}) {
  const parent = params.parentConversationId?.trim();
  const child = params.conversationId.trim();
  return parent && parent !== child
    ? { to: `channel:${parent}`, threadId: child }
    : { to: normalizeMattermostMessagingTarget(`channel:${child}`) };
}
