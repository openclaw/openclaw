import type { ChannelId } from "../../channels/plugins/types.js";
export declare function normalizeChannelTargetInput(raw: string): string;
export declare function normalizeTargetForProvider(provider: string, raw?: string): string | undefined;
export declare function buildTargetResolverSignature(channel: ChannelId): string;
