export type InstalledTerminalDependencyReference = {
  policy: { dependencies: Record<string, string>; legacyPeerDeps?: boolean };
  requiredPackages: Record<string, string>;
  packages: Record<string, { resolution: { integrity: string } }>;
};
export type InstalledTerminalDependencyEdge = {
  from: string;
  name: string;
  spec: string;
  type: string;
  to: string | null;
  optionalAbsent: boolean;
};
export function extractInstalledTerminalCachedPackage(options: {
  npmCli: string;
  cache: string;
  integrity: string;
  directory: string;
}): Promise<string>;
export function inspectInstalledTerminalDependencyNodes(
  application: unknown,
  nodes: readonly unknown[],
  roots: readonly string[],
  reference: InstalledTerminalDependencyReference,
): {
  packages: Array<{
    node: unknown;
    root: string;
    key: string;
    integrity: string;
    location: string;
  }>;
  edges: InstalledTerminalDependencyEdge[];
  selected: Map<string, unknown>;
  bins: Map<string, string[]>;
};
