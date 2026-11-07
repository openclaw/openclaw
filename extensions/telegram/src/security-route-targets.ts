import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";

export const resolveTelegramAuditRouteTargets: NonNullable<
  NonNullable<ChannelPlugin["security"]>["resolveAuditRouteTargets"]
> = async ({ cfg, accountId }) => {
  const { resolveThreadBindingSpawnPolicy } =
    await import("openclaw/plugin-sdk/conversation-runtime");
  // The bot installs an empty binding adapter when disabled. An enabled owner may
  // hold memory-only routes that a cold audit cannot enumerate from durable state.
  return resolveThreadBindingSpawnPolicy({ cfg, channel: "telegram", accountId, kind: "subagent" })
    .enabled
    ? { kind: "unknown" }
    : { kind: "complete", additionalAgentIds: [] };
};
