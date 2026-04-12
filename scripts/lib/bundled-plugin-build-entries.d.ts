export type BundledPluginBuildEntry = {
  id: string;
  hasPackageJson: boolean;
  packageJson: unknown;
  sourceEntries: string[];
};

export type BundledPluginBuildEntryParams = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function collectBundledPluginBuildEntries(
  params?: BundledPluginBuildEntryParams,
): BundledPluginBuildEntry[];
export function listBundledPluginBuildEntries(
  params?: BundledPluginBuildEntryParams,
): Record<string, string>;
export function listBundledPluginPackArtifacts(params?: BundledPluginBuildEntryParams): string[];
export function listBundledPluginRuntimeDependencies(
  params?: BundledPluginBuildEntryParams,
): string[];
