#!/usr/bin/env node
export function parseWorkspaceDependencyDirs(raw?: string, cwd?: string): string[];
export function resolveWorkspaceInstallPlan(
  args: unknown,
  workspaceDirs: unknown,
  cwd?: string,
): {
  installArgs: unknown;
  prefixDir: string;
  rootArchive: string;
} | null;
export function buildInstallManifest(
  rootArchive: unknown,
  workspacePackages: unknown,
): {
  private: boolean;
  dependencies: {
    openclaw: string;
  };
};
export function resolveNpmEnvironment(args: unknown, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function rewriteWorkspaceDependencyVersions(
  packageJson: unknown,
  workspacePackages: unknown,
): number;
