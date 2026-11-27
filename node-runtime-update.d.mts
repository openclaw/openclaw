import type { NodeRuntimeInstallCommand } from "./node-runtime-recovery.mjs";
export function resolveUpdatedNodeRuntime(
  recoveryRoot: string,
  options?: {
    allowInstall?: boolean;
    env?: NodeJS.ProcessEnv;
    acceptVersion?: (version: string) => boolean;
    nodeVersion?: string;
    installCommand?: NodeRuntimeInstallCommand;
  },
): Promise<string | null>;
