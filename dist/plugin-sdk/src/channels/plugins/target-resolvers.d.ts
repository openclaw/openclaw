import type { ChannelResolveResult } from "./types.adapters.js";
export declare function buildUnresolvedTargetResults(inputs: string[], note: string): ChannelResolveResult[];
export declare function resolveTargetsWithOptionalToken<TResult>(params: {
    token?: string | null;
    inputs: string[];
    missingTokenNote: string;
    resolveWithToken: (params: {
        token: string;
        inputs: string[];
    }) => Promise<TResult[]>;
    mapResolved: (entry: TResult) => ChannelResolveResult;
}): Promise<ChannelResolveResult[]>;
