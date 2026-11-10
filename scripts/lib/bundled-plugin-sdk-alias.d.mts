export function ensureOpenClawExtensionAlias(params: {
  distExtensionsRoot: string;
  repoRoot: string;
  aliasDir?: string;
}): void;

export function writeRuntimeModuleWrapper(
  sourcePath: string,
  targetPath: string,
  finalPath?: string,
): void;
