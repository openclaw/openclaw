export { findCrabboxBinary, resolveCrabboxBinary } from "./src/crabbox-binary.js";
export type { CrabboxBinary } from "./src/crabbox-managed-binary.js";

/** Installation-only image preparation uses the same verified runtime cache owner as enrollment. */
export async function createCrabboxOfflineRuntimeSetup(
  params: Parameters<
    typeof import("./src/crabbox-worker-node-enrollment.js").createCrabboxOfflineRuntimeSetup
  >[0],
) {
  const runtime = await import("./src/crabbox-worker-node-enrollment.js");
  return runtime.createCrabboxOfflineRuntimeSetup(params);
}

// Local staging and binary discovery do not need the command and PTY runtime.
export async function ensureManagedCrabboxBinary(
  params?: Parameters<
    typeof import("./src/crabbox-managed-binary.js").ensureManagedCrabboxBinary
  >[0],
) {
  const managed = await import("./src/crabbox-managed-binary.js");
  return managed.ensureManagedCrabboxBinary(params);
}
