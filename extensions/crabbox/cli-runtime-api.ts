export { findCrabboxBinary, resolveCrabboxBinary } from "./src/crabbox-binary.js";
export type { CrabboxBinary } from "./src/crabbox-managed-binary.js";

export async function createCrabboxOfflineRuntimeSetup(
  params: Parameters<
    typeof import("./src/crabbox-worker-node-enrollment.js").createCrabboxOfflineRuntimeSetup
  >[0],
) {
  const runtime = await import("./src/crabbox-worker-node-enrollment.js");
  return runtime.createCrabboxOfflineRuntimeSetup(params);
}

export async function createCrabboxRuntimeCacheVerification(
  params: Parameters<
    typeof import("./src/crabbox-worker-node-enrollment.js").createCrabboxRuntimeCacheVerification
  >[0],
) {
  const runtime = await import("./src/crabbox-worker-node-enrollment.js");
  return runtime.createCrabboxRuntimeCacheVerification(params);
}

export {
  parseCrabboxRuntimeInstallation,
  readCrabboxRuntimeInstallation,
  type CrabboxRuntimeInstallation,
  type CrabboxRuntimeInstallationIdentity,
} from "./src/crabbox-worker-runtime-verification.js";

// Local staging and binary discovery do not need the command and PTY runtime.
export async function ensureManagedCrabboxBinary(
  params?: Parameters<
    typeof import("./src/crabbox-managed-binary.js").ensureManagedCrabboxBinary
  >[0],
) {
  const managed = await import("./src/crabbox-managed-binary.js");
  return managed.ensureManagedCrabboxBinary(params);
}
