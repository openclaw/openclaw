import type { ChannelIngressAdapter, ResolveChannelMessageIngressParams } from "./runtime-types.js";
import type { AccessGroupMembershipFact, ChannelIngressChannelId } from "./types.js";
export declare function allReferencedAccessGroupNames(entries: Array<readonly (string | number)[]>): string[];
export declare function normalizeEffectiveEntries(params: {
    adapter: ChannelIngressAdapter;
    accountId: string;
    entries: readonly (string | number)[];
    context: "dm" | "group" | "route" | "command";
}): Promise<string[]>;
export declare function resolveRuntimeAccessGroupMembershipFacts(params: {
    input: ResolveChannelMessageIngressParams;
    channelId: ChannelIngressChannelId;
    names: readonly string[];
}): Promise<AccessGroupMembershipFact[]>;
