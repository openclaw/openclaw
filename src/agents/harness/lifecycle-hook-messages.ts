import type {
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentFinalizeEvent,
} from "../../plugins/hook-types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const hookMessageLoaders = resolveGlobalSingleton(
  Symbol.for("openclaw.agentHarnessHookMessageLoaders"),
  () => new WeakMap<object, () => Promise<unknown[]>>(),
);

/** Internal evidence belongs to this one event, without expanding the plugin hook contract. */
export function bindAgentHarnessHookMessages<
  Event extends PluginHookAgentEndEvent | PluginHookBeforeAgentFinalizeEvent,
>(event: Event, loadMessages: () => Promise<unknown[]>): Event {
  hookMessageLoaders.set(event, loadMessages);
  return event;
}

export function takeHookMessageLoader(event: object) {
  const load = hookMessageLoaders.get(event);
  hookMessageLoaders.delete(event);
  return load;
}
