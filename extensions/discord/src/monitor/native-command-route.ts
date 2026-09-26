import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isDelegatedChannelBindingTargetAsync,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveDiscordBoundConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";
import type { ThreadBindingRecord } from "./thread-bindings.js";

type ResolvedConfiguredBindingRoute = ReturnType<typeof resolveConfiguredBindingRoute>;
type ConfiguredBindingResolution = NonNullable<
  NonNullable<ResolvedConfiguredBindingRoute>["bindingResolution"]
>;

type DiscordNativeInteractionRouteState = {
  route: ResolvedAgentRoute;
  effectiveRoute: ResolvedAgentRoute;
  boundSessionKey?: string;
  configuredRoute: ResolvedConfiguredBindingRoute | null;
  configuredBinding: ConfiguredBindingResolution | null;
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
  readThreadBinding?: () => ThreadBindingRecord | undefined;
  assertCurrent?: () => void;
}): Promise<DiscordNativeInteractionRouteState> {
  const candidate = params.readThreadBinding ? params.readThreadBinding() : params.threadBinding;
  const identity = (binding: ThreadBindingRecord | undefined) =>
    binding &&
    JSON.stringify([
      binding.accountId,
      binding.channelId,
      binding.threadId,
      binding.targetSessionKey,
      binding.targetKind,
      binding.agentId,
      binding.boundBy,
      binding.boundAt,
      binding.metadata,
    ]);
  const selectedIdentity = identity(candidate);
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (params.readThreadBinding && identity(params.readThreadBinding()) !== selectedIdentity) {
      throw new Error(
        "Discord thread binding changed while preparing the command; retry the interaction.",
      );
    }
  };
  const threadBinding =
    candidate &&
    !(await isDelegatedChannelBindingTargetAsync(
      {
        conversation: { channel: "discord" },
        targetSessionKey: candidate.targetSessionKey,
        targetKind: candidate.targetKind === "subagent" ? "subagent" : "session",
        metadata: { ...candidate.metadata, boundBy: candidate.boundBy, agentId: candidate.agentId },
      },
      assertCurrent,
      params.cfg,
    ))
      ? candidate
      : undefined;
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
  let configuredRoute =
    threadBinding == null
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
  const configured = configuredRoute?.bindingResolution;
  if (
    configured &&
    (await isDelegatedChannelBindingTargetAsync(
      {
        ...configured.record,
        targetSessionKey: configured.statefulTarget.sessionKey,
      },
      assertCurrent,
      params.cfg,
    ))
  ) {
    configuredRoute = null;
  }
  assertCurrent();
  const configuredBinding = configuredRoute?.bindingResolution ?? null;
  const configuredBoundSessionKey = normalizeOptionalString(configuredRoute?.boundSessionKey);
  const boundSessionKey =
    normalizeOptionalString(threadBinding?.targetSessionKey) ?? configuredBoundSessionKey;
  const effectiveRoute = resolveDiscordEffectiveRoute({
    route,
    boundSessionKey,
    configuredRoute,
    matchedBy: configuredBinding ? "binding.channel" : undefined,
  });
  return {
    route,
    effectiveRoute,
    boundSessionKey,
    configuredRoute,
    configuredBinding,
  };
}
