import { Dn as ProviderResolveWebSocketSessionPolicyContext, In as ProviderWebSocketSessionPolicy, Pn as ProviderTransportTurnState, Tn as ProviderResolveTransportTurnStateContext } from "../../types-D1CySu2x.js";
//#region extensions/openai/transport-policy.d.ts
declare function resolveOpenAITransportTurnState(ctx: ProviderResolveTransportTurnStateContext): ProviderTransportTurnState | undefined;
declare function resolveOpenAIWebSocketSessionPolicy(ctx: ProviderResolveWebSocketSessionPolicyContext): ProviderWebSocketSessionPolicy | undefined;
//#endregion
export { resolveOpenAITransportTurnState, resolveOpenAIWebSocketSessionPolicy };