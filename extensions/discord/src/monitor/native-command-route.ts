// Discord plugin module implements native command route behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as conversationRuntime from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  buildAgentMainSessionKey,
  deriveLastRoutePolicy,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveDiscordBoundConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";
import type { ThreadBindingRecord } from "./thread-bindings.js";

type ResolvedConfiguredBindingRoute = ReturnType<
  typeof conversationRuntime.resolveConfiguredBindingRoute
>;
type ConfiguredBindingResolution = NonNullable<
  NonNullable<ResolvedConfiguredBindingRoute>["bindingResolution"]
>;

type DiscordNativeInteractionRouteState = {
  route: ResolvedAgentRoute;
  effectiveRoute: ResolvedAgentRoute;
  boundSessionKey?: string;
  configuredRoute: ResolvedConfiguredBindingRoute | null;
  configuredBinding: ConfiguredBindingResolution | null;
  bindingReadiness: Awaited<
    ReturnType<typeof conversationRuntime.ensureConfiguredBindingRouteReady>
  > | null;
};

export type DiscordNativeBindingTarget = {
  agentId: string;
  sessionKey: string;
};

export function resolveDiscordNativeBindingTarget(params: {
  threadBinding?: ThreadBindingRecord;
  configuredBinding?: ConfiguredBindingResolution | null;
}): DiscordNativeBindingTarget | undefined {
  const threadSessionKey = normalizeOptionalString(params.threadBinding?.targetSessionKey);
  const threadAgentId = normalizeOptionalString(params.threadBinding?.agentId);
  // ThreadBindingManager normalizes every persisted record to the required
  // agentId before it reaches native routing; a partial record is invalid.
  if (threadSessionKey && threadAgentId) {
    return { agentId: threadAgentId, sessionKey: threadSessionKey };
  }
  const configuredTarget = params.configuredBinding?.statefulTarget;
  const configuredSessionKey = normalizeOptionalString(configuredTarget?.sessionKey);
  const configuredAgentId = normalizeOptionalString(configuredTarget?.agentId);
  if (configuredSessionKey && configuredAgentId) {
    return { agentId: configuredAgentId, sessionKey: configuredSessionKey };
  }
  return undefined;
}

export function resolveDiscordNativeBoundRoute(params: {
  cfg: OpenClawConfig;
  effectiveRoute: ResolvedAgentRoute;
  bindingTarget?: DiscordNativeBindingTarget;
}): ResolvedAgentRoute {
  if (!params.bindingTarget) {
    return params.effectiveRoute;
  }
  const mainSessionKey = buildAgentMainSessionKey({
    agentId: params.bindingTarget.agentId,
    mainKey: params.cfg.session?.mainKey,
  });
  return {
    ...params.effectiveRoute,
    agentId: params.bindingTarget.agentId,
    sessionKey: params.bindingTarget.sessionKey,
    mainSessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey: params.bindingTarget.sessionKey,
      mainSessionKey,
    }),
  };
}

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
      ? conversationRuntime.resolveConfiguredBindingRoute({
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
  const configuredBoundSessionKey = normalizeOptionalString(configuredRoute?.boundSessionKey);
  const bindingTarget = resolveDiscordNativeBindingTarget({
    threadBinding: params.threadBinding,
    configuredBinding,
  });
  const boundSessionKey = bindingTarget?.sessionKey ?? configuredBoundSessionKey;
  const routedEffectiveRoute = resolveDiscordEffectiveRoute({
    route,
    boundSessionKey,
    configuredRoute,
    matchedBy: configuredBinding ? "binding.channel" : undefined,
  });
  const effectiveRoute = resolveDiscordNativeBoundRoute({
    cfg: params.cfg,
    effectiveRoute: routedEffectiveRoute,
    bindingTarget,
  });
  const bindingReadiness =
    params.enforceConfiguredBindingReadiness && configuredBinding
      ? await conversationRuntime.ensureConfiguredBindingRouteReady({
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
