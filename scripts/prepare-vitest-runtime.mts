import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// Explicit test builds use the same checkout ownership and live-dist fence as pnpm build.
import { runBuildAllSteps } from "./build-all.mts";
import { runCancelableCommand } from "./lib/cancelable-command.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import { resolveLiveManagedGatewayDistFence } from "./lib/live-gateway-dist-fence.mts";
import {
  RUNTIME_POSTBUILD_STAMP_FILE,
  writeRuntimePostBuildStamp,
} from "./lib/local-build-metadata.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { resolveRunNodeInputSignature } from "./lib/run-node-input-state.mts";
import { resolveRunNodePreparation } from "./run-node.mts";
import { runRuntimePostBuild } from "./runtime-postbuild.mts";
import { listTsdownOutputRoots } from "./tsdown-build.mts";

export async function prepareTestRuntime(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  options: { requireCurrentHead?: boolean; withAiPackage?: boolean } = {},
): Promise<number> {
  signal?.throwIfAborted();
  const runtimeEnv = options.withAiPackage
    ? { ...env, OPENCLAW_BUILD_PRIVATE_QA: "1", OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" }
    : env;
  let builtTypedAi = false;
  const initial = resolveRunNodePreparation(cwd, runtimeEnv, {
    allowEquivalentInputs: !options.requireCurrentHead,
  });
  const status =
    !initial.build && !initial.runtime
      ? 0
      : await withDistArtifactOwnership(
          cwd,
          async () => {
            signal?.throwIfAborted();
            const preparation = resolveRunNodePreparation(cwd, runtimeEnv, {
              allowEquivalentInputs: !options.requireCurrentHead,
            });
            if (preparation.immutable) {
              throw new Error(
                "Cannot prepare tests in an immutable deployment; use a separate source checkout.",
              );
            }
            if (preparation.build) {
              const result = await runBuildAllSteps("qaRuntime", {
                cwd,
                env: runtimeEnv,
                signal,
                requireVerifiedGatewayFence: true,
              });
              // Only this completed typed compiler generation can replace the E2E AI
              // writer. Reused output and postbuild-only preparation cannot prove it ran.
              builtTypedAi =
                result.exitCode === 0 &&
                runtimeEnv.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD === "0" &&
                result.timings.some(
                  (timing) => timing.label === "tsdown" && timing.status === "ran",
                );
              return result.exitCode;
            }
            if (preparation.runtime) {
              const fence = await resolveLiveManagedGatewayDistFence(cwd, {
                env: runtimeEnv,
                requireVerified: true,
                outputPaths: listTsdownOutputRoots(),
              });
              signal?.throwIfAborted();
              if (fence.refuse) {
                console.error(fence.message);
                return 1;
              }
              const inputSignature = resolveRunNodeInputSignature(
                {
                  cwd,
                  distRoot: path.join(cwd, "dist"),
                  fs,
                  env: runtimeEnv,
                  spawnSync,
                },
                "runtime",
              );
              fs.rmSync(path.join(cwd, "dist", RUNTIME_POSTBUILD_STAMP_FILE), { force: true });
              runRuntimePostBuild({ cwd, env: runtimeEnv });
              signal?.throwIfAborted();
              writeRuntimePostBuildStamp({ cwd, env: runtimeEnv, inputSignature });
            }
            return 0;
          },
          signal,
        );
  if (
    status !== 0 ||
    !options.withAiPackage ||
    (builtTypedAi && env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD !== "1")
  ) {
    return status;
  }
  // Release runtime ownership before the standalone writer takes its own claim;
  // retain the caller's environment rather than the typed QA preparation settings.
  signal?.throwIfAborted();
  return runManagedCommand({
    bin: process.execPath,
    args: ["--import", "tsx", "scripts/tsdown-build.mts", "--config", "tsdown.ai.config.ts"],
    cwd,
    env,
    signal,
  });
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--require-current-head" && arg !== "--with-ai-package")) {
    throw new Error(
      "Usage: prepare-vitest-runtime.mjs [--require-current-head] [--with-ai-package]",
    );
  }
  process.exitCode = await runCancelableCommand((signal) =>
    prepareTestRuntime(process.cwd(), process.env, signal, {
      requireCurrentHead: args.includes("--require-current-head"),
      withAiPackage: args.includes("--with-ai-package"),
    }),
  );
}
