export type BunCliLauncherTarget = { bunPath: string; entryPath: string };
export type BunCliLauncherParams = { packageRoot: string; bunPath: string; binDir: string };
export type BunCliLauncherInspection = {
  path: string;
  state: "current" | "missing" | "stale" | "conflict";
};
export function renderBunCliLauncher(target: BunCliLauncherTarget): string;
export function getBunCliLauncherPathIssue(target: BunCliLauncherTarget): string | null;
export function parseBunCliLauncher(content: string): BunCliLauncherTarget | null;
export function resolveBunGlobalBinDir(params: {
  bunPath: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): string;
export function inspectBunCliLauncher(params: BunCliLauncherParams): BunCliLauncherInspection;
export function installBunCliLauncher(params: BunCliLauncherParams): BunCliLauncherInspection;
