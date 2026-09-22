import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vitestWorkerDeclarationEntries } from "./vitest-worker-declarations.mts";

export type VitestWorkerDescriptor = { directory: string };
export type VitestWorkerManifest = {
  identity: string;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  durationMs: number;
};
const root = fileURLToPath(new URL("../../", import.meta.url));
export const hashVitestWorkerArtifact = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
// Compiler/Vite IDs use forward slashes on Windows; filesystem paths use native separators.
const nativeModulePath = (id: string) => path.normalize(id.replaceAll("\\", "/"));
const declarations = new Map(
  Object.entries(vitestWorkerDeclarationEntries).map(([entry, source]) => [
    nativeModulePath(path.join(root, source)),
    entry,
  ]),
);
export const VITEST_WORKER_PREPARE_REQUEST = "openclaw:prepare-test-subprocesses";
export const VITEST_WORKER_PREPARE_REPLY = "openclaw:test-subprocesses-prepared";

export async function verifyVitestWorkerArtifacts(
  directory: string,
  manifest?: VitestWorkerManifest,
) {
  const completed: VitestWorkerManifest =
    manifest ??
    JSON.parse(await fs.promises.readFile(path.join(directory, "manifest.json"), "utf8"));
  const groups = [
    {
      files: completed.inputs,
      root: undefined,
      changed: "Source changed during compiled subprocess invocation",
    },
    {
      files: completed.outputs,
      root: path.join(directory, "dist"),
      changed: "Compiled subprocess artifact changed",
    },
  ];
  const batchSize = 32;
  for (const { files, root: baseDir, changed } of groups) {
    const entries = Object.entries(files);
    for (let offset = 0; offset < entries.length; offset += batchSize) {
      // Native batches keep pre-install planning dependency-free and signals responsive.
      // Drain every started read before rejection: the owner may delete files next.
      const settled = await Promise.allSettled(
        entries.slice(offset, offset + batchSize).map(async ([name, expected]) => {
          const filename = baseDir ? path.join(baseDir, name) : name;
          if (hashVitestWorkerArtifact(await fs.promises.readFile(filename)) !== expected) {
            throw new Error(`${changed}: ${name}`);
          }
        }),
      );
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        throw failed.reason;
      }
    }
  }
}

export function resolveVitestWorkerDeclaration(id: string, directory: string): string | undefined {
  const entry = declarations.get(nativeModulePath(id));
  if (entry) {
    const compiled = path.join(directory, "dist", `${entry}.js`);
    fs.accessSync(compiled);
    return compiled.replaceAll("\\", "/");
  }
  return undefined;
}

export function isVitestWorkerDeclaration(id: string): boolean {
  return declarations.has(nativeModulePath(id));
}

/** One finite request over the already-owned Node IPC channel; never a path/build request. */
export function requestVitestWorkerArtifacts(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("Compiled subprocess owner IPC is unavailable"));
      return;
    }
    const finish = (error?: Error) => {
      signal?.removeEventListener("abort", onAbort);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      process.channel?.unref();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = () => finish(new Error("Compiled subprocess preparation request canceled"));
    const onDisconnect = () => finish(new Error("Compiled subprocess owner disconnected"));
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === VITEST_WORKER_PREPARE_REPLY
      ) {
        finish("error" in message ? new Error(String(message.error)) : undefined);
      }
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    process.channel?.ref();
    process.send(VITEST_WORKER_PREPARE_REQUEST, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
}
