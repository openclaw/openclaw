import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { VoiceSessionEntry } from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";
export declare const DISCORD_VOICE_MESSAGE_PROVIDER = "discord-voice";
export type DiscordVoiceIngressContext = {
    extraSystemPrompt?: string;
    senderIsOwner: boolean;
    speakerLabel: string;
};
export type DiscordVoiceAgentTurnResult = {
    context: DiscordVoiceIngressContext;
    text: string;
};
export declare function resolveDiscordVoiceIngressContext(params: {
    entry: VoiceSessionEntry;
    userId: string;
    cfg: OpenClawConfig;
    discordConfig: DiscordAccountConfig;
    ownerAllowFrom?: string[];
    fetchGuildName: (guildId: string) => Promise<string | undefined>;
    speakerContext: DiscordVoiceSpeakerContextResolver;
}): Promise<DiscordVoiceIngressContext | null>;
export declare function runDiscordVoiceAgentTurn(params: {
    entry: VoiceSessionEntry;
    userId: string;
    message: string;
    cfg: OpenClawConfig;
    discordConfig: DiscordAccountConfig;
    runtime: RuntimeEnv;
    context?: DiscordVoiceIngressContext;
    toolsAllow?: string[];
    ownerAllowFrom?: string[];
    fetchGuildName: (guildId: string) => Promise<string | undefined>;
    speakerContext: DiscordVoiceSpeakerContextResolver;
}): Promise<DiscordVoiceAgentTurnResult | null>;
export declare function resolveDiscordVoiceRealtimeBootstrapContext(params: {
    entry: VoiceSessionEntry;
    cfg: OpenClawConfig;
    discordConfig: DiscordAccountConfig;
}): Promise<string | undefined>;
