type PackageIdentity = {
  version: string;
  buildInfo: Record<string, unknown>;
  files: Record<string, { sha256: string; size: number } | { symlink: string }>;
};
export function readInstalledTerminalReference(
  role: "current" | "historical",
  encoded: string,
): import("./installed-terminal-dependencies.mjs").InstalledTerminalDependencyReference;
export function assertInstalledTerminalApplication(
  identity: PackageIdentity,
  prepared: Awaited<ReturnType<typeof prepareInstalledTerminalApplication>>,
): { roles: Record<string, string>; assetsSha256: string };
export function readInstalledTerminalDependencyTree(root: string): {
  identity: string;
  entries: number;
  sha256: string;
};
export function assertInstalledTerminalDependencyTree(
  root: string,
  expected: { entries: number; sha256: string },
): ReturnType<typeof readInstalledTerminalDependencyTree>;
export function readInstalledTerminalMetadata(
  root: string,
  identity: PackageIdentity,
): {
  version: string;
  build: Record<string, unknown>;
  files: Record<string, string | null>;
};
export function prepareInstalledTerminalApplication(
  root: string,
  identity: PackageIdentity,
): Promise<{
  roles: Record<string, { sha256: string; files: Array<[string, number, string]> }>;
  assets: Array<[string, number, string]>;
  metadata: ReturnType<typeof readInstalledTerminalMetadata>;
}>;
