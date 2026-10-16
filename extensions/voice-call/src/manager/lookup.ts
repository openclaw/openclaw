import type { CallId, CallRecord } from "../types.js";

/** Resolve an active call through the index maintained by call mutations. */
export function getCallByProviderCallId(params: {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  providerCallId: string;
}): CallRecord | undefined {
  const callId = params.providerCallIdMap.get(params.providerCallId);
  return callId ? params.activeCalls.get(callId) : undefined;
}

/** Resolve an active call by internal call id or provider call id. */
export function findCall(params: {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  callIdOrProviderCallId: string;
}): CallRecord | undefined {
  return (
    params.activeCalls.get(params.callIdOrProviderCallId) ??
    getCallByProviderCallId({
      activeCalls: params.activeCalls,
      providerCallIdMap: params.providerCallIdMap,
      providerCallId: params.callIdOrProviderCallId,
    })
  );
}
