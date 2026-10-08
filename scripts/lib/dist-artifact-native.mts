// Optional source-only bootstrap for the fixed native compiler operation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { runDistArtifactCommand } from "./dist-artifact-command.mts";
import type { NativeArtifactOwner } from "./runtime-artifact-contract.ts";

export async function runNativeArtifactOperation(
  root: string,
  args: string[],
  compilerPath: string,
  acquireOwner: () => Promise<NativeArtifactOwner>,
): Promise<number> {
  // Metrics invoke configurable Git provenance helpers, whose delegated work is
  // not necessarily a descendant. The early metrics branch stays noncertifying.
  const { createVitestWorkerRun, CompiledSubprocessExitError } =
    await import("./vitest-worker-run.mts");
  const { verifyVitestWorkerArtifacts, hashVitestWorkerArtifact } =
    await import("./vitest-worker-artifacts.mts");
  const compilerInput = fs.realpathSync(compilerPath);
  const compilerHash = hashVitestWorkerArtifact(fs.readFileSync(compilerInput));
  const runtime = createVitestWorkerRun(process.env, undefined, "artifact-custody");
  try {
    try {
      // This owner prepares an exclusive content-verified generation, not dist.
      // Finish it BEFORE artifact admission: compilation must never recursively
      // wait for the fence that the command it is preparing will hold.
      const prepared = await runtime.prepare();
      const manifest = {
        ...prepared,
        inputs: { ...prepared.inputs, [compilerInput]: compilerHash },
      };
      await verifyVitestWorkerArtifacts(runtime.descriptor.directory, manifest);
      const native: { runDistArtifactCommand: typeof runDistArtifactCommand } = await import(
        pathToFileURL(
          path.join(runtime.descriptor.directory, "dist/tooling/dist-artifact-command.js"),
        ).href
      );
      const owner = await acquireOwner();
      let nativeSettled = false;
      try {
        // Recheck after waiting, before either application loading or child spawn.
        await verifyVitestWorkerArtifacts(runtime.descriptor.directory, manifest);
        if (!(await owner.lock.verifyStillHeld())) {
          throw new Error("Artifact ownership changed before native launch");
        }
        const launchStartedAt = Date.now();
        const code = await runtime.join(
          native.runDistArtifactCommand(
            [
              fileURLToPath(new URL("./dist-artifact-ownership.mts", import.meta.url)),
              "--native-custody",
              owner.custodyId,
              new URL("../run-tsgo.mts", import.meta.url).href,
              ...args,
            ],
            root,
            owner.admitNativeRoot,
          ),
        );
        // The supported source entry must not change its launch closure during
        // execution. Native extinction alone cannot certify manager-delegated work
        // introduced by a concurrent source edit. Changed/restored inputs refuse.
        await verifyVitestWorkerArtifacts(runtime.descriptor.directory, manifest, {
          inputsChangedAfter: launchStartedAt,
        });
        await owner.recordNativeSettlement();
        nativeSettled = true;
        return code;
      } finally {
        // An incomplete launch, missing receipt, or lost host never becomes a
        // caller assertion of extinction. Retain the original fence for inspection.
        if (nativeSettled) {
          await owner.lock.release();
        }
      }
    } finally {
      await runtime.dispose();
    }
  } catch (error) {
    // Translate only a completed compiler exit, after disposal has joined.
    // Cleanup failures must stay visible instead of becoming cancellation status.
    if (error instanceof CompiledSubprocessExitError) {
      return error.exitCode;
    }
    throw error;
  }
}
