import { R as ChannelResolveResult } from "./types.adapters-y0dBEomF.js";

//#region src/channels/plugins/target-resolvers.d.ts
declare function buildUnresolvedTargetResults(inputs: string[], note: string): ChannelResolveResult[];
declare function resolveTargetsWithOptionalToken<TResult>(params: {
  token?: string | null;
  inputs: string[];
  missingTokenNote: string;
  resolveWithToken: (params: {
    token: string;
    inputs: string[];
  }) => Promise<TResult[]>;
  mapResolved: (entry: TResult) => ChannelResolveResult;
}): Promise<ChannelResolveResult[]>;
//#endregion
export { resolveTargetsWithOptionalToken as n, buildUnresolvedTargetResults as t };