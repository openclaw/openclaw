import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";

export function canMutateCodexHost(ctx: PluginCommandContext): boolean {
  return ctx.senderIsOwner === true || ctx.gatewayClientScopes?.includes("operator.admin") === true;
}
