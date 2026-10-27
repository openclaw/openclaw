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
