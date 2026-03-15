export function shouldEnableTopLevelParallel({ isCI, testProfile }) {
  // CI runners are memory-constrained relative to local dev boxes.
  // Keep lane execution serial in CI to avoid heap spikes when multiple
  // vitest lanes run concurrently.
  if (isCI) {
    return false;
  }
  return testProfile !== "low" && testProfile !== "serial";
}

export function resolveVitestPoolForWorkerClamp({ pool, maxWorkers }) {
  // vmForks + a single worker has shown cross-file leakage in CI (notably macOS).
  // When we intentionally clamp a lane to one worker, force process forks.
  if (maxWorkers === 1 && pool === "vmForks") {
    return "forks";
  }
  return pool;
}
