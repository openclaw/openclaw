import { bn as ProviderReplayPolicy, xn as ProviderReplayPolicyContext } from "../../types-Vx7Jq4_-2.js";
//#region extensions/anthropic/replay-policy.d.ts
declare const buildReplayPolicy: ((ctx: ProviderReplayPolicyContext) => ProviderReplayPolicy | null | undefined) | undefined;
//#endregion
export { buildReplayPolicy as buildAnthropicReplayPolicy };