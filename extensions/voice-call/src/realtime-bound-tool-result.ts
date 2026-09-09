const GATEWAY_BOUND_EXACT_SPEECH = Symbol("voice-call.gateway-bound-exact-speech");

/** Keep exact-speech authority internal while submitting the plain tool result to the provider. */
export function markGatewayBoundRealtimeToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  // SAFETY: the guards above establish a non-array object before reading a string key.
  const spokenResponse = (result as Record<string, unknown>).spokenResponse;
  if (typeof spokenResponse !== "string" || !spokenResponse.trim()) {
    return result;
  }
  Object.defineProperty(result, GATEWAY_BOUND_EXACT_SPEECH, {
    value: spokenResponse.trim(),
    enumerable: false,
  });
  return result;
}

export function readGatewayBoundExactSpeech(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  // SAFETY: the guards above establish a non-array object before reading our private symbol.
  const value = (result as Record<symbol, unknown>)[GATEWAY_BOUND_EXACT_SPEECH];
  return typeof value === "string" ? value : undefined;
}
