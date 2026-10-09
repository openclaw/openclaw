// Real-runtime proof for the bounded followup-drain suspension path.
//
// Run: pnpm tsx scripts/proof-w91n-followup-drain-terminal.ts
//
// No vitest, no mocks of the seam under test. The real
// `enqueueFollowupRun` / `scheduleFollowupDrain` / `FOLLOWUP_QUEUES` registry and
// the real Gateway work-admission fence drive every scenario, with the shipped
// retry policy (no timing overrides), so the wall-clock cost of scenario 1 is
// the production backoff ladder itself. Only `defaultRuntime.error` is captured,
// at the logging edge, so the suspension message can be asserted.
//
// Scenarios:
//   1. An item whose run throws the non-retriable authority error is retried a
//      bounded number of times, then parked with one loud suspension error, and
//      the loop stops.
//   2. A deferred item still retries past the unclassified cap and succeeds.
//   3. The Gateway restart fence still parks the drain instead of retiring it.
//   4. An accepted queue-settings command recovers a suspended queue and the
//      production reply path delivers the retained work and then its successor.
//      Scenario 4 drops the synthetic drain callback: the real
//      `createFollowupRunner` product runs each retained turn, real
//      `handleDirectiveOnly` applies a real `/queue reset` through real session
//      persistence against an on-disk store, and delivery is measured where the
//      real `routeReply` hands the final payload to a registered channel
//      plugin. The only simulated things are the two literal edges — a loopback
//      HTTP endpoint in place of the provider API, and that channel adapter in
//      place of the platform transport.
//
// This file is only a bootstrap. It must not statically import production code:
// OpenClaw modules pin runtime paths while their module bodies evaluate
// (`src/config/paths.ts` initializes `STATE_DIR` and `CONFIG_PATH` at import
// time), and ES module imports are hoisted and evaluated before any statement
// here runs. A static import would therefore capture the operator's real state
// directory and credentials regardless of where it appeared in the import list,
// and formatting that reorders imports would silently decide the outcome. The
// isolation module below touches only Node builtins, and the scenario body is
// pulled in by a dynamic import afterwards, which re-verifies the resolved
// paths before running anything.

import { proofHomeDir } from "./proof-w91n-followup-drain-terminal.isolation.js";

async function main(): Promise<void> {
  console.log(`Proof isolation applied; throwaway OpenClaw home: ${proofHomeDir}`);
  const { runProofScenarios } = await import("./proof-w91n-followup-drain-terminal.scenarios.js");
  await runProofScenarios();
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    console.error(String(error));
    process.exit(1);
  },
);
