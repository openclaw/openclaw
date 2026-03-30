import { type Client, ReadyListener } from "@buape/carbon";
import type { OpenClawConfig } from "../../config/config.js";
import type { DiscordAccountConfig } from "../../config/types.js";
import type { RuntimeEnv } from "../../runtime.js";
type VoiceOperationResult = {
    ok: boolean;
    message: string;
    channelId?: string;
    guildId?: string;
};
export declare class DiscordVoiceManager {
    private params;
    private sessions;
    private botUserId?;
    private readonly voiceEnabled;
    private autoJoinTask;
    constructor(params: {
        client: Client;
        cfg: OpenClawConfig;
        discordConfig: DiscordAccountConfig;
        accountId: string;
        runtime: RuntimeEnv;
        botUserId?: string;
    });
    setBotUserId(id?: string): void;
    isEnabled(): boolean;
    autoJoin(): Promise<void>;
    status(): VoiceOperationResult[];
    join(params: {
        guildId: string;
        channelId: string;
    }): Promise<VoiceOperationResult>;
    leave(params: {
        guildId: string;
        channelId?: string;
    }): Promise<VoiceOperationResult>;
    destroy(): Promise<void>;
    private enqueueProcessing;
    private enqueuePlayback;
    private handleSpeakingStart;
    private processSegment;
    private handleReceiveError;
    private resetDecryptFailureState;
    private recoverFromDecryptFailures;
    private resolveSpeakerLabel;
}
export declare class DiscordVoiceReadyListener extends ReadyListener {
    private manager;
    constructor(manager: DiscordVoiceManager);
    handle(): Promise<void>;
}
export {};
