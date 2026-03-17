function getCallByProviderCallId(params) {
  const callId = params.providerCallIdMap.get(params.providerCallId);
  if (callId) {
    return params.activeCalls.get(callId);
  }
  for (const call of params.activeCalls.values()) {
    if (call.providerCallId === params.providerCallId) {
      return call;
    }
  }
  return void 0;
}
function findCall(params) {
  const directCall = params.activeCalls.get(params.callIdOrProviderCallId);
  if (directCall) {
    return directCall;
  }
  return getCallByProviderCallId({
    activeCalls: params.activeCalls,
    providerCallIdMap: params.providerCallIdMap,
    providerCallId: params.callIdOrProviderCallId
  });
}
export {
  findCall,
  getCallByProviderCallId
};
