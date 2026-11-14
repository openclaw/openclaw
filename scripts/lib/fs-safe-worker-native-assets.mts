import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { parse } from "yaml";
import { WORKER_BUNDLE_DARWIN_NATIVE_ARTIFACTS } from "../../src/shared/worker-bundle-hash.ts";
import { pnpmLockfileDocuments } from "./pnpm-lockfile-documents.mjs";

export type WorkerNativeAsset = { fileName: string; source: Buffer; sha256: string };
const registryUrl = "https://registry.npmjs.org/";
const assetsByIdentity = new Map<string, Promise<WorkerNativeAsset[]>>();
const nativeLoad =
  "const loaded = runNativeInitialization(() => require(nativePackageForTarget(target)));";

/** Use the dependency's existing exact pins; no package installation or host-native lookup. */
async function resolveWorkerNativePins(rootDir: string, manifestPath: string) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    optionalDependencies: Record<string, string>;
  };
  const lockPath = path.join(rootDir, "pnpm-lock.yaml");
  const lock = parse(pnpmLockfileDocuments(await fs.readFile(lockPath, "utf8")).dependencies) as {
    packages: Record<string, { resolution: { integrity: string } }>;
  };
  return Object.entries(WORKER_BUNDLE_DARWIN_NATIVE_ARTIFACTS).map(([target, fileName]) => {
    const name = `@openclaw/fs-safe-${target}`;
    const version = manifest.optionalDependencies[name];
    const integrity = lock.packages[`${name}@${version}`]?.resolution.integrity;
    if (!/^\d+\.\d+\.\d+$/u.test(version ?? "") || !integrity) {
      throw new Error(
        `Worker native asset is not pinned in the installed manifest and lock: ${name}`,
      );
    }
    const digest = createHash("sha256").update(integrity).digest("hex");
    return { fileName, name, version, integrity, cachedName: `${target}-${version}-${digest}.tgz` };
  });
}

function verifyWorkerNativeArchive(bytes: Buffer, integrity: string, name: string) {
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) {
    throw new Error(`Worker native package archive integrity mismatch: ${name}`);
  }
}

/** Admit only lock-pinned public package bytes, never the surrounding host artifact cache. */
export async function copyWorkerNativeArchiveCache(
  rootDir: string,
  snapshot: string,
  manifestPath: string,
) {
  const pins = await resolveWorkerNativePins(snapshot, manifestPath);
  const archives = await Promise.all(
    pins.map(async (pin) => {
      const file = path.join(rootDir, ".artifacts", "worker-native-assets", pin.cachedName);
      let bytes: Buffer;
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || (await fs.realpath(file)) !== file) {
          throw new Error("Expected an ordinary bounded archive without symlinked ancestors");
        }
        bytes = await fs.readFile(file);
      } catch (cause) {
        throw new Error(
          `Offline worker native archive unavailable: ${pin.name}@${pin.version}. Prepare the pinned build assets before isolation.`,
          { cause },
        );
      }
      verifyWorkerNativeArchive(bytes, pin.integrity, pin.name);
      return { pin, bytes };
    }),
  );
  const cache = path.join(snapshot, ".artifacts", "worker-native-assets");
  // Source admission excludes .artifacts; never adopt preexisting snapshot state.
  await fs.mkdir(path.dirname(cache), { mode: 0o700 });
  await fs.mkdir(cache, { mode: 0o700 });
  for (const archive of archives) {
    await fs.writeFile(path.join(cache, archive.pin.cachedName), archive.bytes, {
      flag: "wx",
      mode: 0o600,
    });
  }
  return archives.map(({ pin: { name, version, integrity }, bytes }) => ({
    name,
    version,
    integrity,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
}

export async function prepareWorkerDarwinNativeAssets(rootDir: string, manifestPath: string) {
  const pins = await resolveWorkerNativePins(rootDir, manifestPath);
  const identity = JSON.stringify([path.resolve(rootDir), pins]);
  let pending = assetsByIdentity.get(identity);
  if (!pending) {
    pending = Promise.all(
      pins.map(async ({ cachedName, fileName, name, version, integrity }) => {
        const cache = path.join(rootDir, ".artifacts", "worker-native-assets");
        await fs.mkdir(cache, { recursive: true });
        const cached = path.join(cache, cachedName);
        let bytes: Buffer | undefined;
        try {
          bytes = await fs.readFile(cached);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
        const cacheMiss = bytes === undefined;
        if (bytes === undefined) {
          const slug = name.slice(name.lastIndexOf("/") + 1);
          const response = await fetch(`${registryUrl}${name}/-/${slug}-${version}.tgz`, {
            redirect: "error",
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error(
              `Worker native package download failed: ${name} HTTP ${response.status}`,
            );
          }
          const downloaded: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > 32 * 1024 * 1024) {
              throw new Error(`Worker native package archive exceeds its byte limit: ${name}`);
            }
            downloaded.push(chunk);
          }
          bytes = Buffer.concat(downloaded);
        }
        verifyWorkerNativeArchive(bytes, integrity, name);
        if (cacheMiss) {
          const staging = `${cached}.${randomUUID()}`;
          try {
            await fs.writeFile(staging, bytes, { flag: "wx", mode: 0o600 });
            await fs.rename(staging, cached);
          } finally {
            await fs.rm(staging, { force: true });
          }
        }
        const chunks: Buffer[] = [];
        let entries = 0;
        let invalid = false;
        await pipeline(
          Readable.from([bytes]),
          tar.list({
            strict: true,
            onReadEntry(entry) {
              if (entry.path !== "package/fs-safe-native.node") {
                return;
              }
              entries++;
              if (entry.type !== "File" || entry.size > 32 * 1024 * 1024) {
                invalid = true;
                return;
              }
              entry.on("data", (chunk: Buffer) => chunks.push(chunk));
            },
          }),
        );
        const source = Buffer.concat(chunks);
        if (invalid || entries !== 1 || source.length === 0) {
          throw new Error(`Worker native package is missing its unique addon: ${name}`);
        }
        return { fileName, source, sha256: createHash("sha256").update(source).digest("hex") };
      }),
    );
    assetsByIdentity.set(identity, pending);
  }
  return pending;
}

/** Keep the native loader inside the admitted archive; never resolve an installed host package. */
export function transformWorkerDarwinNativeLoader(code: string, assets: WorkerNativeAsset[]) {
  if (code.split(nativeLoad).length !== 2) {
    throw new Error("fs-safe native loader changed; update the worker deploy transform");
  }
  const expected = Object.fromEntries(
    Object.entries(WORKER_BUNDLE_DARWIN_NATIVE_ARTIFACTS).map(([target, fileName]) => [
      target,
      { fileName, sha256: assets.find((asset) => asset.fileName === fileName)?.sha256 },
    ]),
  );
  return `import { createHash as workerNativeHash } from "node:crypto";
import { readFileSync as workerNativeBytes } from "node:fs";
import { fileURLToPath as workerNativePath } from "node:url";
${code.replace(
  nativeLoad,
  `const loaded = runNativeInitialization(() => {
  const asset = ${JSON.stringify(expected)}[target];
  if (!asset?.sha256) throw new Error("Worker fs-safe native target is unavailable");
  const location = new URL("./" + asset.fileName, import.meta.url);
  if (workerNativeHash("sha256").update(workerNativeBytes(location)).digest("hex") !== asset.sha256) {
    throw new Error("Worker fs-safe native asset integrity mismatch");
  }
  return require(workerNativePath(location));
});`,
)}`;
}
