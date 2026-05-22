import { _n as ProviderReplayPolicyContext, gn as ProviderReplayPolicy } from "../../types-BM0xoSYJ2.js";
//#region extensions/anthropic/replay-policy.d.ts
declare const buildReplayPolicy: ((ctx: ProviderReplayPolicyContext) => ProviderReplayPolicy | null | undefined) | undefined;
//#endregion
export { buildReplayPolicy as buildAnthropicReplayPolicy };