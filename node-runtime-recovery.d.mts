export function consumeLauncherRootOptionToken(args: string[], index: number): number;
export function isForegroundGmailRunInvocation(argv: string[]): boolean;
export function isNativeHookRelayInvocation(argv: string[]): boolean;
export function resolveRecoveryPath(
  value: string | null | undefined,
  homeDir?: string | null,
  options?: { allowMissing?: boolean; allowCwd?: boolean; trustedRoot?: string },
): string | null;
export function isUsableNode(
  nodePath: string,
  options?: {
    allowCwd?: boolean;
    trustedRoot?: string;
    env?: NodeJS.ProcessEnv;
    acceptVersion?: (version: string) => boolean;
  },
): boolean;
export function runRespawnedChild(command: string, args: string[], env: NodeJS.ProcessEnv): true;
export function recoverNodeRuntime(options?: {
  homeDir?: string;
  allowInstall?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean>;

export type NodeRuntimeInstallCommand = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<number | null>;
export function findUsableNodeRuntime(options?: {
  homeDir?: string;
  allowInstall?: boolean;
  env?: NodeJS.ProcessEnv;
  acceptVersion?: (version: string) => boolean;
  nodeVersion?: string;
  installCommand?: NodeRuntimeInstallCommand;
}): Promise<{ nodePath: string; reason: string } | null>;
