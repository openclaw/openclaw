export function fileDigest(file: string): string;
export function fileIdentity(file: string): string;
export function installedRecoveryEvidenceMode(directory: string, isDirectory?: boolean): number;
export function openInstalledRecoveryEvidence(file: string): number;
export function writeInstalledRecoveryEvidence(file: string, value: unknown): void;
export function startInstalledRecoveryRun(
  artifacts: string,
  cut: string,
): {
  directory: string;
  summary: string;
};
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
