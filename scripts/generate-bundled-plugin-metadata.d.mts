export type BundledPluginPathPair = {
  source: string;
  built: string;
};

export type BundledPluginMetadataEntry = {
  dirName: string;
  idHint: string;
  source: BundledPluginPathPair;
  setupSource?: BundledPluginPathPair;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageManifest?: Record<string, unknown>;
  manifest: Record<string, unknown>;
};

export function collectBundledPluginMetadata(params?: {
  repoRoot?: string;
}): Promise<BundledPluginMetadataEntry[]>;

export function renderBundledPluginMetadataModule(entries: BundledPluginMetadataEntry[]): string;

export function writeBundledPluginMetadataModule(params?: {
  repoRoot?: string;
  outputPath?: string;
  entriesOutputPath?: string;
  check?: boolean;
}): Promise<{
  changed: boolean;
  wrote: boolean;
  outputPaths: string[];
}>;
