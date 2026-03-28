export function rewritePackageExtensions(entries: unknown): string[] | undefined;

export function copyBundledPluginMetadata(params?: {
  repoRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): void;
