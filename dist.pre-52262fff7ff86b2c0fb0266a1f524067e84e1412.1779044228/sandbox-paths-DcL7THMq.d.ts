//#region src/agents/sandbox-paths.d.ts
declare function resolveSandboxInputPath(filePath: string, cwd: string): string;
declare function resolveSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
}): {
  resolved: string;
  relative: string;
};
declare function assertSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  allowFinalSymlinkForUnlink?: boolean;
  allowFinalHardlinkForUnlink?: boolean;
}): Promise<{
  resolved: string;
  relative: string;
}>;
declare function assertMediaNotDataUrl(media: string): void;
declare function resolveAllowedManagedMediaPath(candidate: string): Promise<string | undefined>;
declare function resolveSandboxedMediaSource(params: {
  media: string;
  sandboxRoot: string;
}): Promise<string>;
//#endregion
export { resolveSandboxPath as a, resolveSandboxInputPath as i, assertSandboxPath as n, resolveSandboxedMediaSource as o, resolveAllowedManagedMediaPath as r, assertMediaNotDataUrl as t };