export function verifyResult(expected, observation) {
  const success = observation.textBlocks?.some((t) =>
    t.toLowerCase().includes((expected || "").toLowerCase())
  );

  return {
    success,
    shouldRetry: !success,
    reason: success ? "MATCH" : "NO_MATCH"
  };
}
