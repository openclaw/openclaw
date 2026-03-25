import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  resolveDiscordBoundConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";
import type { ThreadBindingRecord } from "./thread-bindings.js";

type ResolvedConfiguredBindingRoute = ReturnType<typeof resolveConfiguredBindingRoute>;
type ConfiguredBindingResolution = NonNullable<
  NonNullable<ResolvedConfiguredBindingRoute>["bindingResolution"]
>;

export type DiscordNativeInteractionRouteState = {
  route: ResolvedAgentRoute;
  effectiveRoute: ResolvedAgentRoute;
  boundSessionKey?: string;
  configuredRoute: ResolvedConfiguredBindingRoute | null;
  configuredBinding: ConfiguredBindingResolution | null;
  bindingReadiness: Awaited<ReturnType<typeof ensureConfiguredBindingRouteReady>> | null;
};

export async function resolveDiscordNativeInteractionRouteState(params: {
  cfg: OpenClawConfig;
  accountId: string;
  guildId?: string;
  memberRoleIds?: string[];
  isDirectMessage: boolean;
  isGroupDm: boolean;
  directUserId?: string;
  conversationId: string;
  parentConversationId?: string;
  threadBinding?: ThreadBindingRecord;
  enforceConfiguredBindingReadiness?: boolean;
}): Promise<DiscordNativeInteractionRouteState> {
  const route = resolveDiscordBoundConversationRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    guildId: params.guildId,
    memberRoleIds: params.memberRoleIds,
    isDirectMessage: params.isDirectMessage,
    isGroupDm: params.isGroupDm,
    directUserId: params.directUserId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  const configuredRoute =
    params.threadBinding == null
      ? resolveConfiguredBindingRoute({
          cfg: params.cfg,
          route,
          conversation: {
            channel: "discord",
            accountId: params.accountId,
            conversationId: params.conversationId,
            parentConversationId: params.parentConversationId,
          },
        })
      : null;
  const configuredBinding = configuredRoute?.bindingResolution ?? null;
  const configuredBoundSessionKey = configuredRoute?.boundSessionKey?.trim() || undefined;
  const boundSessionKey =
    params.threadBinding?.targetSessionKey?.trim() || configuredBoundSessionKey;
  const effectiveRoute = resolveDiscordEffectiveRoute({
    route,
    boundSessionKey,
    configuredRoute,
    matchedBy: configuredBinding ? "binding.channel" : undefined,
  });
  const bindingReadiness =
    params.enforceConfiguredBindingReadiness && configuredBinding
      ? await ensureConfiguredBindingRouteReady({
          cfg: params.cfg,
          bindingResolution: configuredBinding,
        })
      : null;
  return {
    route,
    effectiveRoute,
    boundSessionKey,
    configuredRoute,
    configuredBinding,
    bindingReadiness,
  };
}
