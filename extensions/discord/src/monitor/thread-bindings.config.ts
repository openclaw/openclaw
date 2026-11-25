import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingsEnabled,
} from "openclaw/plugin-sdk/conversation-runtime";

export { resolveThreadBindingsEnabled };

export function resolveDiscordThreadBindingIdleTimeoutMs(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): number {
  return resolveThreadBindingIdleTimeoutMsForChannel({ ...params, channel: "discord" });
}

export function resolveDiscordThreadBindingMaxAgeMs(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): number {
  return resolveThreadBindingMaxAgeMsForChannel({ ...params, channel: "discord" });
}
