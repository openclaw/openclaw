import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedCommand } from "./managed-child-process.mts";
import { createVitestResourceOwner } from "./vitest-resource-ownership.mts";
import {
  requestVitestWorkerArtifacts,
  verifyVitestWorkerArtifacts,
  VITEST_WORKER_PREPARE_REQUEST,
  VITEST_WORKER_PREPARE_REPLY,
  type VitestWorkerDescriptor,
  type VitestWorkerManifest,
} from "./vitest-worker-artifacts.mts";
import { useVitestWorkerCache } from "./vitest-worker-cache-policy.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));

function createVitestWorkerDirectory(env: NodeJS.ProcessEnv) {
  const parent = path.join(root, ".artifacts", "vitest-workers");
  fs.mkdirSync(parent, { recursive: true });
  let directory: string;
  if (!useVitestWorkerCache(env)) {
    directory = fs.mkdtempSync(path.join(parent, "run-"));
  } else {
    // A retained or live generation keeps its slot. Only joined disposal releases it.
    for (let slot = 0; ; slot++) {
      directory = path.join(parent, `run-cache-${slot}`);
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    }
  }
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
  return directory;
}

/** The invocation owns preparation and waits for every real borrower before disposal. */
export function createVitestWorkerRun(
  env: NodeJS.ProcessEnv = process.env,
  parent?: VitestWorkerDescriptor,
) {
  const directory = parent?.directory ?? createVitestWorkerDirectory(env);
  let preparation: Promise<VitestWorkerManifest> | undefined;
  let retainArtifacts:
    | typeof import("./vitest-worker-cache.mts").retainVitestWorkerArtifacts
    | undefined;
  let disposal: Promise<void> | undefined;
  const borrowers: Promise<unknown>[] = [];
  let channelError: Error | undefined;
  const compilerAbort = new AbortController();
  let compilerJoined = true;
  let resources: ReturnType<typeof createVitestResourceOwner> | undefined;
  let resourcesReleased = true;
  const onParentDisconnect = () => {
    channelError ??= new Error("Compiled subprocess owner disconnected before group completion");
    console.error(channelError);
    compilerAbort.abort();
    // Reuse the group's normal signal/descendant cleanup, including pending admission.
    process.kill(process.pid, "SIGTERM");
  };
  if (parent) {
    if (!process.connected) {
      throw new Error("Compiled subprocess owner IPC is unavailable");
    }
    process.once("disconnect", onParentDisconnect);
    process.channel?.unref();
  }

  function prepare(): Promise<VitestWorkerManifest> {
    if (disposal) {
      return Promise.reject(new Error("Compiled subprocess owner is closing"));
    }
    return (preparation ??= (async () => {
      if (parent) {
        // One upstream loan serves this group's real borrowers; each still verifies below.
        await requestVitestWorkerArtifacts(compilerAbort.signal);
        return JSON.parse(
          await fs.promises.readFile(path.join(directory, "manifest.json"), "utf8"),
        ) as VitestWorkerManifest;
      }
      if (useVitestWorkerCache(env)) {
        // Load cleanup before the runner's loader service can stop during shutdown.
        retainArtifacts = (await import("./vitest-worker-cache.mts")).retainVitestWorkerArtifacts;
      }
      compilerJoined = false;
      const code = await runManagedCommand({
        bin: process.execPath,
        args: [fileURLToPath(new URL("./vitest-worker-compiler.mts", import.meta.url)), directory],
        cwd: root,
        env,
        shell: false,
        // Match the native declaration owner: POSIX group/output join; Windows close/taskkill.
        requireProcessTreeExit: process.platform !== "win32",
        signal: compilerAbort.signal,
      }).then(
        (exitCode) => {
          compilerJoined = true;
          return exitCode;
        },
        (error: unknown) => {
          // Managed abort rejects only after verified termination. Uncertain
          // cleanup (including aggregated setup failure) must retain this generation.
          compilerJoined = Boolean(
            error &&
            typeof error === "object" &&
            (("code" in error && error.code === "ABORT_ERR") ||
              ("code" in error &&
                error.code === "EPROCESSGROUP_CLEANUP_FAILED" &&
                "processTreeState" in error &&
                error.processTreeState === "terminated")),
          );
          throw error;
        },
      );
      if (code !== 0) {
        throw new Error(`Compiled subprocess build failed with exit code ${code}`);
      }
      const manifest: VitestWorkerManifest = JSON.parse(
        fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
      );
      console.error(
        `[vitest-workers] prepared ${manifest.identity.slice(0, 12)} in ${Math.round(manifest.durationMs)}ms (${Object.keys(manifest.inputs).length} inputs, ${Object.keys(manifest.outputs).length} outputs)`,
      );
      // The compiler requires a fresh directory; publish fixture ownership only before lending.
      resources = createVitestResourceOwner(directory);
      resourcesReleased = false;
      return manifest;
    })());
  }
  return {
    descriptor: { directory } satisfies VitestWorkerDescriptor,
    prepare,
    borrow<T>(
      child: ChildProcess,
      completion: Promise<T>,
      onPreparationProgress?: () => void,
    ): Promise<T> {
      let request: Promise<void> | undefined;
      const onMessage = (message: unknown) => {
        if (message !== VITEST_WORKER_PREPARE_REQUEST || request) {
          return;
        }
        request = (async () => {
          let reply: { type: string; error?: string } = { type: VITEST_WORKER_PREPARE_REPLY };
          try {
            const manifest = await prepare();
            await verifyVitestWorkerArtifacts(directory, manifest);
            if (disposal) {
              throw new Error("Compiled subprocess owner is closing");
            }
            onPreparationProgress?.();
          } catch (error) {
            reply = { type: VITEST_WORKER_PREPARE_REPLY, error: String(error) };
          }
          if (child.connected) {
            child.send(reply, (error) => {
              channelError ??= error ?? undefined;
            });
          }
        })();
        // Only accepted admission and verified readiness count as progress.
        // Duplicate IPC and the compiler's intermediate output cannot renew it.
        if (!disposal) {
          onPreparationProgress?.();
        }
      };
      child.on("message", onMessage);
      // Existing Windows completion observes exit; artifact ownership additionally
      // waits for close so inherited handles cannot outlive deletion.
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      const joined = (async () => {
        try {
          return await completion;
        } finally {
          await closed;
          child.off("message", onMessage);
        }
      })();
      // Child completion must let callers reach disposal to cancel compilation.
      // The owner still joins admission reads before releasing their generation.
      const ownedCompletion = (async () => {
        try {
          await joined;
        } finally {
          await request;
        }
      })();
      borrowers.push(ownedCompletion);
      void ownedCompletion.catch(() => {});
      return joined;
    },
    dispose(): Promise<void> {
      return (disposal ??= (async () => {
        compilerAbort.abort();
        const settled = await Promise.allSettled(borrowers);
        const uncertain = settled.find((result) => result.status === "rejected");
        try {
          const manifest = await preparation;
          resources?.assertReleased();
          resourcesReleased = true;
          if (uncertain?.status === "rejected") {
            throw uncertain.reason;
          }
          if (channelError) {
            throw channelError;
          }
          if (fs.existsSync(path.join(directory, "manifest.json"))) {
            console.error("[vitest-workers] verifying completed generation before cleanup");
            await verifyVitestWorkerArtifacts(directory, manifest);
          }
          if (!parent && manifest?.cacheSignature) {
            if (await retainArtifacts?.(root, directory, manifest)) {
              console.error("[vitest-workers] retained completed compiler outputs for reuse");
            }
          }
        } finally {
          process.off("disconnect", onParentDisconnect);
          if (uncertain || !compilerJoined || !resourcesReleased) {
            console.error(
              `[vitest-workers] retaining ${directory}: ${!compilerJoined ? "compiler" : !resourcesReleased ? "fixture resource" : "borrower"} join failed`,
            );
          } else if (!parent) {
            // Large generations must not block signal delivery during final cleanup.
            // Desktop metadata can arrive between child deletion and the final rmdir.
            await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3 });
          }
        }
      })());
    },
  };
}

export type VitestWorkerRun = ReturnType<typeof createVitestWorkerRun>;
