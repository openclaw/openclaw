export const retirementCuts: readonly string[];
export function sha256(bytes: string | Uint8Array): string;
export function fileDigest(file: string): string;
export function fileIdentity(file: string): string;
export function installedRecoveryEvidenceMode(directory: string, isDirectory?: boolean): number;
export function openInstalledRecoveryEvidence(file: string): number;
export function writeInstalledRecoveryEvidence(file: string, value: unknown): void;
export function startInstalledRecoveryRun(
  artifacts: string,
  cut?: string,
): {
  directory: string;
  summary: string;
};
export function readActivation(journal: string): Record<string, string | number | null>;
export function assertInstalledRecoveryConfig(
  original: Uint8Array,
  updated: Uint8Array,
  inspected: Uint8Array,
): void;
export type PackageTreeEntry = {
  path: string;
  kind: "directory" | "file" | "link";
  mode: number;
  uid: string;
  gid: string;
  identity: string;
  content: string | null;
};
export function capturePackageTree(
  root: string,
  limits?: { maxEntries?: number; maxBytes?: number },
): PackageTreeEntry[];
export function assertPackageTree(
  expected: readonly PackageTreeEntry[],
  actual: PackageTreeEntry[],
  options?: { tightenPermissions?: boolean },
): PackageTreeEntry[];
export function parseRecoveryCommand(output: string): {
  node: string;
  helper: string;
  anchor: string;
  operation: string;
};
export function assertRetirementCut(
  cut: string,
  evidence: {
    cut: string;
    row: { phase: string; intent_json: string };
    effect: string;
    synced?: boolean;
  },
  anchor: string,
  helper: string,
): void;
