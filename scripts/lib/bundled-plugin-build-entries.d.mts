// Declaration contract for the plain-Node bundled-plugin build inventory.
export type BundledPluginBuildEntry = {
  id: string;
  hasManifest: boolean;
  hasPackageJson: boolean;
  packageJson: unknown;
  catalogSourceEntries: string[];
  sourceEntries: string[];
};

export type BundledPluginBuildCandidate = {
  dirName: string;
  pluginDir: string;
  relativeFiles: string[] | null;
  topLevelPublicSurfaceEntries: string[];
};

export type BundledPluginBuildEntryParams = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  includeRootPackageExcludedDirs?: boolean;
  includeExternalSourceEntries?: boolean;
  getCandidates?: () => BundledPluginBuildCandidate[];
};

export const DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV: string;
export const BUNDLED_PLUGIN_BUILD_ENV_NAMES: string[];
export function resolvePluginRuntimeFormat(packageJson: unknown): "cjs" | "esm";
export function pluginRuntimeExtension(runtimeFormat: "cjs" | "esm"): ".cjs" | ".js";
export function mapPluginCatalogEntries<T extends Record<string, unknown>>(
  manifest: T,
  mapEntry: (entry: string) => string | undefined,
): T;
export function createBundledPluginBuildInventory(cwd?: string): {
  cwd: string;
  getCandidates: () => BundledPluginBuildCandidate[];
};
export function parseDockerSelectedPluginBuildIdFilter(env?: NodeJS.ProcessEnv): Set<string> | null;
export function collectPluginSourceEntries(
  packageJson: unknown,
  manifest?: Record<string, unknown>,
): string[];
export function collectPluginDeclarationSourceEntries(
  packageJson: unknown,
  sourceEntries: string[],
): string[];
export function collectTopLevelPublicSurfaceEntries(pluginDir: string): string[];
export function collectRootPackageExcludedExtensionDirs(
  params?: BundledPluginBuildEntryParams,
): Set<string>;
export function collectBundledPluginBuildEntries(
  params?: BundledPluginBuildEntryParams,
): BundledPluginBuildEntry[];
export function listBundledPluginPackArtifacts(params?: BundledPluginBuildEntryParams): string[];

export function collectSourceCheckoutPluginBuildEntries(
  params?: BundledPluginBuildEntryParams,
): (BundledPluginBuildEntry & { isolated: boolean; runtimeExtension: ".cjs" | ".js" })[];
export function collectRetainedDoctorBuildEntries(
  params?: BundledPluginBuildEntryParams & { surface?: string },
): Record<string, string>;
