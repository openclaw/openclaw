import { createRequire } from "node:module";
// Phase E maintainer contract. The Windows implementation is supplied by the
// plugin-owned native addon; this module keeps all policy decisions testable on
// every host and refuses mutation before the native boundary is available.

export const PHASE_E_POOL = Object.freeze(
  Array.from({ length: 8 }, (_, index) => `srt-w0-${String(index + 1).padStart(2, "0")}`),
);

export type PhaseEMode = "preflight" | "setup" | "repair" | "rollback" | "teardown";
export type PhaseEManifest = {
  version: 1;
  generation: number;
  owner: "srt-phase-e-maintainer";
  invocationId: string;
  createdAccounts: readonly { name: string; sid: string }[];
  crc32: string;
};
export type PhaseEEvidence = {
  schema: "phase-e-evidence/v1";
  mode: PhaseEMode;
  outcome:
    | "PREFLIGHT_OK"
    | "SETUP_COMPLETE"
    | "REPAIR_COMPLETE"
    | "ROLLBACK_COMPLETE"
    | "TEARDOWN_COMPLETE"
    | "BLOCKED";
  maintainer: { pid: number; creationTime: string };
  canonicalAccounts: readonly { name: string; sid?: string }[];
  legacyAccountCount: number;
  seclogon: "RUNNING" | "SETUP_REQUIRED" | "UNKNOWN";
  manifestGeneration: number;
};

export class PhaseEMaintainerError extends Error {}

/** Reject partial pools, legacy collisions, duplicate SIDs, and unknown names. */
export function inspectCanonicalPool(
  accounts: readonly { name: string; sid: string }[],
): "absent" | "ready" {
  const canonical = accounts.filter((account) => PHASE_E_POOL.includes(account.name));
  if (canonical.length === 0) return "absent";
  if (canonical.length !== PHASE_E_POOL.length) {
    throw new PhaseEMaintainerError("PHASE_E_NAMESPACE_AMBIGUOUS");
  }
  if (
    new Set(canonical.map((account) => account.name)).size !== PHASE_E_POOL.length ||
    new Set(canonical.map((account) => account.sid)).size !== PHASE_E_POOL.length
  ) {
    throw new PhaseEMaintainerError("PHASE_E_NAMESPACE_AMBIGUOUS");
  }
  return "ready";
}

/** Teardown is manifest-owned only: foreign accounts are never candidates. */
export function rollbackCandidates(manifest: PhaseEManifest, invocationId: string): string[] {
  if (manifest.owner !== "srt-phase-e-maintainer" || manifest.invocationId !== invocationId) {
    throw new PhaseEMaintainerError("PHASE_E_MANIFEST_OWNERSHIP_MISMATCH");
  }
  return manifest.createdAccounts.map((account) => account.name);
}

/** A small deterministic checksum for the versioned initial lease-store header. */
export function leaseStoreCrc(generation: number, slots: readonly string[]): string {
  let value = 0x811c9dc5;
  for (const byte of Buffer.from(`phase-e-v1:${generation}:${slots.join(",")}`)) {
    value = Math.imul(value ^ byte, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
}

/** Evidence is schema-checked at its source, never free-form then redacted. */
export function redactPhaseEEvidence(_: string): never {
  throw new PhaseEMaintainerError("PHASE_E_EVIDENCE_MUST_BE_TYPED");
}

/** The maintainer is Windows-only and never falls back to a subprocess. */
export function assertPhaseEPlatform(platform = process.platform): void {
  if (platform !== "win32") throw new PhaseEMaintainerError("PHASE_E_UNSUPPORTED_PLATFORM");
}

/**
 * Native addon ABI. Its methods map directly to NetAPI, SCM, FWPM, DPAPI and
 * handle-based NTFS security calls. It is intentionally not loaded on non-Windows.
 */
export type PhaseENativeApi = { run(mode: PhaseEMode, manifestJson?: string): string };
const validModes = new Set<PhaseEMode>(["preflight", "setup", "repair", "rollback", "teardown"]);
const allowedEvidence = new Set([
  "schema",
  "mode",
  "outcome",
  "maintainer",
  "canonicalAccounts",
  "legacyAccountCount",
  "seclogon",
  "manifestGeneration",
]);

export function parsePhaseEEvidence(value: string, mode: PhaseEMode): PhaseEEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new PhaseEMaintainerError("PHASE_E_INVALID_EVIDENCE");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Object.keys(parsed).some((key) => !allowedEvidence.has(key))
  )
    throw new PhaseEMaintainerError("PHASE_E_INVALID_EVIDENCE");
  const evidence = parsed as PhaseEEvidence;
  if (
    evidence.schema !== "phase-e-evidence/v1" ||
    evidence.mode !== mode ||
    !validModes.has(evidence.mode) ||
    !Number.isInteger(evidence.legacyAccountCount) ||
    !Number.isInteger(evidence.manifestGeneration) ||
    !Array.isArray(evidence.canonicalAccounts) ||
    evidence.canonicalAccounts.some(
      (a) =>
        !a ||
        typeof a.name !== "string" ||
        !PHASE_E_POOL.includes(a.name) ||
        (a.sid !== undefined && typeof a.sid !== "string"),
    ) ||
    !evidence.maintainer ||
    !Number.isInteger(evidence.maintainer.pid) ||
    typeof evidence.maintainer.creationTime !== "string"
  )
    throw new PhaseEMaintainerError("PHASE_E_INVALID_EVIDENCE");
  return evidence;
}

export function loadPhaseENativeApi(requireFn = createRequire(import.meta.url)): PhaseENativeApi {
  try {
    const addon = requireFn("../build/Release/phase_e_maintainer.node") as Partial<PhaseENativeApi>;
    if (typeof addon.run !== "function") throw new Error("missing run");
    return addon as PhaseENativeApi;
  } catch {
    throw new PhaseEMaintainerError("PHASE_E_NATIVE_ADDON_UNAVAILABLE");
  }
}

export function runPhaseEMaintainer(
  mode: PhaseEMode,
  nativeApi?: PhaseENativeApi,
  platform = process.platform,
): PhaseEEvidence {
  assertPhaseEPlatform(platform);
  if (!validModes.has(mode)) throw new PhaseEMaintainerError("PHASE_E_INVALID_MODE");
  return parsePhaseEEvidence((nativeApi ?? loadPhaseENativeApi()).run(mode), mode);
}
