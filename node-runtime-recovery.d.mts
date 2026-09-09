export function consumeLauncherRootOptionToken(args: string[], index: number): number;
export function isForegroundGmailRunInvocation(argv: string[]): boolean;
export function isNativeHookRelayInvocation(argv: string[]): boolean;
export function isUsableNode(nodePath: string): boolean;
export function runRespawnedChild(command: string, args: string[], env: NodeJS.ProcessEnv): true;
export function recoverNodeRuntime(options?: {
  homeDir?: string;
  allowInstall?: boolean;
}): Promise<boolean>;
