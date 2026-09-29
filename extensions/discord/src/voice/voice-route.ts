import type { OpenClawConfig, DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
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
  if (agentSession?.mode !== "target") {
    return {
      route: voiceRoute,
      voiceRoute,
      agentSessionMode: "voice" as const,
      agentSessionTarget: undefined,
    };
  }
  const target = agentSession.target?.trim();
  if (!target) {
    throw new Error('channels.discord.voice.agentSession.target is required when mode is "target"');
  }
  const parsed = parseDiscordTarget(target, { defaultKind: "channel" });
  if (!parsed) {
    throw new Error(`Invalid Discord voice agent session target "${target}"`);
  }
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "discord",
    accountId: params.accountId,
    guildId: params.guildId,
    peer: {
      kind: parsed.kind === "user" ? "direct" : "channel",
      id: parsed.id,
    },
  });
  return {
    route,
    voiceRoute,
    agentSessionMode: "target" as const,
    agentSessionTarget: parsed.normalized,
  };
}
