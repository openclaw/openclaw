export function shouldEnableTopLevelParallel({ isCI, testProfile }) {
  // CI runners are memory-constrained relative to local dev boxes.
  // Keep lane execution serial in CI to avoid heap spikes when multiple
  // vitest lanes run concurrently.
  if (isCI) {
    return false;
  }
  return testProfile !== "low" && testProfile !== "serial";
}
