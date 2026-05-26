//#region src/infra/home-dir.d.ts
declare function resolveEffectiveHomeDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string | undefined;
declare function resolveOsHomeDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string | undefined;
declare function resolveRequiredHomeDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
declare function resolveRequiredOsHomeDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
declare function expandHomePrefix(input: string, opts?: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): string;
declare function resolveHomeRelativePath(input: string, opts?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): string;
declare function resolveUserPath(input: string, env?: NodeJS.ProcessEnv, homedir?: () => string): string;
declare function resolveOsHomeRelativePath(input: string, opts?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): string;
//#endregion
export { resolveOsHomeRelativePath as a, resolveUserPath as c, resolveOsHomeDir as i, resolveEffectiveHomeDir as n, resolveRequiredHomeDir as o, resolveHomeRelativePath as r, resolveRequiredOsHomeDir as s, expandHomePrefix as t };