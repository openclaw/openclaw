import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { type VoiceSessionEntry } from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";
export declare function processDiscordVoiceSegment(params: {
    entry: VoiceSessionEntry;
    wavPath: string;
    userId: string;
    durationSeconds: number;
    cfg: OpenClawConfig;
    discordConfig: DiscordAccountConfig;
    runtime: RuntimeEnv;
    ownerAllowFrom?: string[];
    fetchGuildName: (guildId: string) => Promise<string | undefined>;
    speakerContext: DiscordVoiceSpeakerContextResolver;
    enqueuePlayback: (entry: VoiceSessionEntry, task: () => Promise<void>) => void;
}): Promise<void>;
