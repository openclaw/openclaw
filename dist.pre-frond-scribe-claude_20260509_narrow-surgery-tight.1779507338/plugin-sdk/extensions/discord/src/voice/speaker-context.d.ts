import type { Client } from "../internal/discord.js";
type VoiceSpeakerIdentity = {
    id: string;
    label: string;
    name?: string;
    tag?: string;
    memberRoleIds: string[];
};
type VoiceSpeakerContext = Omit<VoiceSpeakerIdentity, "memberRoleIds"> & {
    senderIsOwner: boolean;
};
export declare class DiscordVoiceSpeakerContextResolver {
    private readonly params;
    private readonly cache;
    constructor(params: {
        client: Client;
        ownerAllowFrom?: string[];
    });
    resolveContext(guildId: string, userId: string): Promise<VoiceSpeakerContext>;
    resolveIdentity(guildId: string, userId: string): Promise<VoiceSpeakerIdentity>;
    private resolveIsOwner;
    private resolveCacheKey;
    private getCachedContext;
    private setCachedContext;
}
export {};
