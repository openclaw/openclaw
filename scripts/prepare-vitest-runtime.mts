// Explicit test builds use the same checkout ownership and live-dist fence as pnpm build.
import { runBuildAllSteps } from "./build-all.mts";
import { runCancelableCommand } from "./lib/cancelable-command.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import { resolveLiveManagedGatewayDistFence } from "./lib/live-gateway-dist-fence.mts";
import { writeRuntimePostBuildStamp } from "./lib/local-build-metadata.mts";
import { resolveRunNodePreparation } from "./run-node.mts";
import { runRuntimePostBuild } from "./runtime-postbuild.mts";
import { listTsdownOutputRoots } from "./tsdown-build.mts";

export async function prepareTestRuntime(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const initial = resolveRunNodePreparation(cwd, env);
  if (!initial.build && !initial.runtime) {
    return 0;
  }
  return await withDistArtifactOwnership(
    cwd,
    async () => {
      signal?.throwIfAborted();
      const preparation = resolveRunNodePreparation(cwd, env);
      if (preparation.immutable) {
        throw new Error(
          "Cannot prepare tests in an immutable deployment; use a separate source checkout.",
        );
      }
      if (preparation.build) {
        return (
          await runBuildAllSteps("qaRuntime", {
            cwd,
            env,
            signal,
            requireVerifiedGatewayFence: true,
          })
        ).exitCode;
      }
      if (preparation.runtime) {
        const fence = await resolveLiveManagedGatewayDistFence(cwd, {
          env,
          requireVerified: true,
          outputPaths: listTsdownOutputRoots(),
        });
        signal?.throwIfAborted();
        if (fence.refuse) {
          console.error(fence.message);
          return 1;
        }
        runRuntimePostBuild({ cwd, env });
        signal?.throwIfAborted();
        writeRuntimePostBuildStamp({ cwd, env });
      }
      return 0;
    },
    signal,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = await runCancelableCommand((signal) =>
    prepareTestRuntime(process.cwd(), process.env, signal),
  );
}
