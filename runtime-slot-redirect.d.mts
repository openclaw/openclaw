export function resolveRuntimeSlotsDir(env?: NodeJS.ProcessEnv, argv?: readonly string[]): string;
export function redirectToCurrentRuntimeSlot(
  packageRoot: string,
  options: { gatewayRun: boolean },
): Promise<void>;
