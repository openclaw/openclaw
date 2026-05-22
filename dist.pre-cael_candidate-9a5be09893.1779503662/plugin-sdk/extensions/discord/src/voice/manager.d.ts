import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { type APIVoiceState, type Client, ReadyListener, ResumedListener, VoiceStateUpdateListener } from "../internal/discord.js";
import { type VoiceOperationResult } from "./session.js";
export declare class DiscordVoiceManager {
    private params;
    private sessions;
    private botUserId?;
    private readonly voiceEnabled;
    private autoJoinTask;
    private readonly fatalAutoJoinFailures;
    private readonly ownerAllowFrom?;
    private readonly speakerContext;
    private readonly allowedChannels;
    private readonly followUserIds;
    private readonly followedUserChannels;
    private readonly followedVoiceGuilds;
    private followUsersReconcileTimer;
    private followUsersReconcileTask;
    private followUsersReconcileGuildCursor;
    private followUsersReconcileBotGuildCursor;
    private readonly followUsersReconcileUserCursors;
    private destroyed;
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
    isAllowedVoiceChannel(params: {
        guildId: string;
        channelId: string;
    }): boolean;
    join(params: {
        guildId: string;
        channelId: string;
    }, options?: {
        preserveFollowState?: boolean;
    }): Promise<VoiceOperationResult>;
    leave(params: {
        guildId: string;
        channelId?: string;
    }, options?: {
        preserveFollowState?: boolean;
    }): Promise<VoiceOperationResult>;
    handleVoiceStateUpdate(data: APIVoiceState): Promise<void>;
    private handleBotVoiceStateUpdate;
    private handleFollowedUserVoiceStateUpdate;
    destroy(): Promise<void>;
    private resolveFollowGuildIds;
    private ensureFollowUsersReconcileTimer;
    private reconcileFollowedUsers;
    private runFollowedUsersReconcile;
    private selectFollowUserReconcilePlans;
    private assignFollowUserReconcileBotChecks;
    private resolveFollowUserReconcileUserLookupLimit;
    private selectFollowUserReconcileUserIds;
    private formatFollowedUserKey;
    private hasFollowedUserInChannel;
    private resolveFollowedUserHandoffTarget;
    private handoffToAnotherFollowedUserOrLeave;
    private isFollowOwnedGuild;
    private deleteFollowedUserChannelsForGuild;
    private disconnectStaleFollowedBotVoiceState;
    private resolveVoiceResidencyTarget;
    private enqueueProcessing;
    private enqueuePlayback;
    private clearCaptureFinalizeTimer;
    private scheduleCaptureFinalize;
    private handleSpeakingStart;
    private processRealtimeAudioCapture;
    private resolveDiscordVoiceIngressContext;
    private runDiscordRealtimeAgentTurn;
    private processSegment;
    private handleReceiveError;
    private enableDaveReceivePassthrough;
    private resetDecryptFailureState;
    private recoverFromDecryptFailures;
}
export declare class DiscordVoiceReadyListener extends ReadyListener {
    private manager;
    constructor(manager: DiscordVoiceManager);
    handle(_data: unknown, _client: Client): Promise<void>;
}
export declare class DiscordVoiceResumedListener extends ResumedListener {
    private manager;
    constructor(manager: DiscordVoiceManager);
    handle(_data: unknown, _client: Client): Promise<void>;
}
export declare class DiscordVoiceStateUpdateListener extends VoiceStateUpdateListener {
    private manager;
    constructor(manager: DiscordVoiceManager);
    handle(data: APIVoiceState, _client: Client): Promise<void>;
}
