export const retirementCuts: readonly string[];
export function sha256(bytes: string | Uint8Array): string;
export function fileDigest(file: string): string;
export function fileIdentity(file: string): string;
export function startInstalledRecoveryRun(artifacts: string): {
  directory: string;
  summary: string;
};
export function readActivation(journal: string): Record<string, string | number | null>;
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
