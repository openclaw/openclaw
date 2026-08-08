export const WORKSPACE_TEMPLATE_PACK_PATHS: readonly string[];
export function createWorkspaceBootstrapSmokeEnv(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function runInstalledWorkspaceBootstrapSmoke(params: {
  packageRoot: string;
  nodeArgs?: string[];
  envOverrides?: NodeJS.ProcessEnv;
}): void;
export function buildAndSmokeDistRuntimeArtifact(params: {
  rootDir: string;
  archivePath: string;
  compressor?: string;
}): Promise<{ archivePath: string; artifactPaths: string[] }>;
