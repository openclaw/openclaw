import { gn as ProviderReplayPolicyContext, hn as ProviderReplayPolicy } from "../../types-lCXG2pW_.js";
//#region extensions/anthropic/replay-policy.d.ts
declare const buildReplayPolicy: ((ctx: ProviderReplayPolicyContext) => ProviderReplayPolicy | null | undefined) | undefined;
//#endregion
export { buildReplayPolicy as buildAnthropicReplayPolicy };