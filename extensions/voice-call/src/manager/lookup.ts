import type { CallId, CallRecord } from "../types.js";

/** Resolves a provider call id through the fast map, then active-call state for restored calls. */
export function getCallByProviderCallId(params: {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  providerCallId: string;
}): CallRecord | undefined {
  const callId = params.providerCallIdMap.get(params.providerCallId);
  if (callId) {
    return params.activeCalls.get(callId);
  }

  // Restored calls may predate the in-memory provider id map; scan active state as fallback.
  for (const call of params.activeCalls.values()) {
    if (call.providerCallId === params.providerCallId) {
      return call;
    }
  }
  return undefined;
}

/** Finds a call by internal call id first, then by provider call id. */
export function findCall(params: {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  callIdOrProviderCallId: string;
}): CallRecord | undefined {
  const directCall = params.activeCalls.get(params.callIdOrProviderCallId);
  if (directCall) {
    return directCall;
  }
  return getCallByProviderCallId({
    activeCalls: params.activeCalls,
    providerCallIdMap: params.providerCallIdMap,
    providerCallId: params.callIdOrProviderCallId,
  });
}
