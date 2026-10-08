// Compile the maintained ingress child before its cold-process execution deadline.
export const identityRepeatedTurnEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "../../../test/e2e/qa-lab/runtime/agent-run-identity-repeated-turn-child",
  distWorkerPath: "test-support/agent-run-identity-repeated-turn-child.js",
} as const;
