// Discord plugin module implements voice route resolution.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isPluginOwnedSessionBindingRecord,
  lookupRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
  type ConfiguredBindingRouteResult,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { shouldIgnoreStaleDiscordRouteBinding } from "../monitor/route-resolution.js";
import { parseDiscordTarget } from "../target-parsing.js";

export function resolveDiscordVoiceAgentRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  guildId: string;
  sessionChannelId: string;
  voiceConfig: DiscordAccountConfig["voice"];
}) {
  const voiceRoute = resolveAgentRoute({
    cfg: params.cfg,
    channel: "discord",
    accountId: params.accountId,
    guildId: params.guildId,
    peer: { kind: "channel", id: params.sessionChannelId },
  });
  const agentSession = params.voiceConfig?.agentSession;
  const target = agentSession?.mode === "target" ? agentSession.target?.trim() : undefined;
  if (agentSession?.mode === "target" && !target) {
    throw new Error('channels.discord.voice.agentSession.target is required when mode is "target"');
  }
  const parsed = target ? parseDiscordTarget(target, { defaultKind: "channel" }) : undefined;
  if (target && !parsed) {
    throw new Error(`Invalid Discord voice agent session target "${target}"`);
  }
  const baseRoute = parsed
    ? resolveAgentRoute({
        cfg: params.cfg,
        channel: "discord",
        accountId: params.accountId,
        guildId: params.guildId,
        peer: {
          kind: parsed.kind === "user" ? "direct" : "channel",
          id: parsed.id,
        },
      })
    : voiceRoute;
  const conversationId =
    parsed?.kind === "user" ? parsed.normalized : (parsed?.id ?? params.sessionChannelId);
  const conversation = {
    channel: "discord",
    accountId: params.accountId,
    conversationId,
  };
  const runtimeRoute = lookupRuntimeConversationBindingRoute({
    route: baseRoute,
    conversation,
  });
  const runtimeBindingIsStale = shouldIgnoreStaleDiscordRouteBinding({
    bindingRecord: runtimeRoute.bindingRecord,
    route: baseRoute,
  });
  if (!runtimeBindingIsStale && isPluginOwnedSessionBindingRecord(runtimeRoute.bindingRecord)) {
    // Voice has no plugin-owned target handoff. Falling through would run a
    // different agent while renewing the displaced plugin binding.
    throw new Error("Discord voice cannot dispatch a plugin-owned conversation binding");
  }
  let route: typeof baseRoute;
  let configuredBinding: ConfiguredBindingRouteResult["bindingResolution"];
  if (!runtimeBindingIsStale && runtimeRoute.boundSessionKey) {
    route = runtimeRoute.route;
    configuredBinding = null;
  } else {
    const configuredRoute = resolveConfiguredBindingRoute({
      cfg: params.cfg,
      route: baseRoute,
      conversation,
    });
    route = configuredRoute.route;
    configuredBinding = configuredRoute.bindingResolution;
  }
  return {
    route,
    voiceRoute,
    configuredBinding,
    runtimeBinding: runtimeBindingIsStale ? null : runtimeRoute.bindingRecord,
    agentSessionMode: parsed ? ("target" as const) : ("voice" as const),
    agentSessionTarget: parsed?.normalized,
  };
}

export function isDiscordVoiceRouteCurrent(params: {
  expected: ReturnType<typeof resolveAgentRoute>;
  current: ReturnType<typeof resolveAgentRoute>;
}): boolean {
  return (
    params.current.agentId === params.expected.agentId &&
    params.current.accountId === params.expected.accountId &&
    params.current.sessionKey === params.expected.sessionKey &&
    params.current.matchedBy === params.expected.matchedBy
  );
}
