/**
 * Returns whether oxlint args need package-boundary declaration artifacts first.
 */
export function shouldPrepareExtensionPackageBoundaryArtifacts(args: unknown): boolean;
/**
 * Drops tracked-but-missing sparse-checkout targets so narrow sparse checks can pass.
 */
export function filterSparseMissingOxlintTargets(
  args: unknown,
  {
    cwd,
    fileExists,
    isSparseCheckoutEnabled,
    isTrackedPath,
  }?: {
    cwd?: string | undefined;
    fileExists?: ((target: string) => boolean) | undefined;
    isSparseCheckoutEnabled?: ((params: { cwd: string }) => boolean) | undefined;
    isTrackedPath?: ((params: { cwd: string; target: string }) => boolean) | undefined;
  },
):
  | {
      args: unknown;
      hadExplicitTargets: boolean;
      remainingExplicitTargets: number;
      skippedTargets: never[];
      skippedConfigs: never[];
    }
  | {
      args: unknown[];
      hadExplicitTargets: boolean;
      remainingExplicitTargets: number;
      skippedTargets: unknown[];
      skippedConfigs: unknown[];
    };
/**
 * Applies wrapper policy and runs oxlint with the final argument list.
 */
export function main(argv?: string[], runtimeEnv?: NodeJS.ProcessEnv): Promise<void>;
