import type { CallId, CallRecord } from "../types.js";

/** Resolve an active call from provider call id with map lookup plus stale-map fallback scan. */
export function getCallByProviderCallId(params: {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  providerCallId: string;
}): CallRecord | undefined {
  const callId = params.providerCallIdMap.get(params.providerCallId);
  if (callId) {
    return params.activeCalls.get(callId);
  }

  for (const call of params.activeCalls.values()) {
    if (call.providerCallId === params.providerCallId) {
      return call;
    }
  }
  return undefined;
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
