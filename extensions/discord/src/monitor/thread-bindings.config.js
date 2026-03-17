import {
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingsEnabled
} from "../../../../src/channels/thread-bindings-policy.js";
import { normalizeAccountId } from "../../../../src/routing/session-key.js";
function resolveDiscordThreadBindingIdleTimeoutMs(params) {
  const accountId = normalizeAccountId(params.accountId);
  const root = params.cfg.channels?.discord?.threadBindings;
  const account = params.cfg.channels?.discord?.accounts?.[accountId]?.threadBindings;
  return resolveThreadBindingIdleTimeoutMs({
    channelIdleHoursRaw: account?.idleHours ?? root?.idleHours,
    sessionIdleHoursRaw: params.cfg.session?.threadBindings?.idleHours
  });
}
function resolveDiscordThreadBindingMaxAgeMs(params) {
  const accountId = normalizeAccountId(params.accountId);
  const root = params.cfg.channels?.discord?.threadBindings;
  const account = params.cfg.channels?.discord?.accounts?.[accountId]?.threadBindings;
  return resolveThreadBindingMaxAgeMs({
    channelMaxAgeHoursRaw: account?.maxAgeHours ?? root?.maxAgeHours,
    sessionMaxAgeHoursRaw: params.cfg.session?.threadBindings?.maxAgeHours
  });
}
export {
  resolveDiscordThreadBindingIdleTimeoutMs,
  resolveDiscordThreadBindingMaxAgeMs,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingsEnabled
};
