import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type WorldIdCoreRuntime = typeof import("@worldcoin/idkit-core");

let worldIdCoreRuntimePromise: Promise<WorldIdCoreRuntime> | null = null;
let fileFetchCompatDepth = 0;
let originalFetch: typeof fetch | null = null;
let installedFetch: typeof fetch | null = null;
const runtimeRequire = createRequire(import.meta.url);
let worldIdCoreResolution: {
  entrypoint: string;
  wasmPath: string;
  wasmUrl: string;
} | null = null;

function resolveWorldIdCoreRuntime() {
  if (worldIdCoreResolution) {
    return worldIdCoreResolution;
  }
  const entrypoint = runtimeRequire.resolve("@worldcoin/idkit-core");
  const wasmPath = path.join(path.dirname(entrypoint), "idkit_wasm_bg.wasm");
  worldIdCoreResolution = {
    entrypoint,
    wasmPath,
    wasmUrl: pathToFileURL(wasmPath).href,
  };
  return worldIdCoreResolution;
}

function tryResolveWorldIdCoreRuntime() {
  try {
    return resolveWorldIdCoreRuntime();
  } catch {
    return null;
  }
}

function resolveFileUrlFromFetchInput(input: Parameters<typeof fetch>[0]): URL | null {
  if (input instanceof URL) {
    return input.protocol === "file:" ? input : null;
  }
  if (typeof Request === "function" && input instanceof Request) {
    const url = new URL(input.url);
    return url.protocol === "file:" ? url : null;
  }
  if (typeof input === "string" && input.startsWith("file://")) {
    return new URL(input);
  }
  return null;
}

function isWorldIdCoreWasmUrl(fileUrl: URL): boolean {
  const resolution = tryResolveWorldIdCoreRuntime();
  if (!resolution) {
    return false;
  }
  try {
    return fileUrl.href === resolution.wasmUrl && fileURLToPath(fileUrl) === resolution.wasmPath;
  } catch {
    return false;
  }
}

function installNodeFileFetchCompat(): () => void {
  if (typeof globalThis.fetch !== "function") {
    return () => {};
  }
  if (fileFetchCompatDepth === 0) {
    originalFetch = globalThis.fetch;
    const nativeFetch = originalFetch.bind(globalThis);
    installedFetch = (async (input, init) => {
      const fileUrl = resolveFileUrlFromFetchInput(input);
      if (fileUrl && isWorldIdCoreWasmUrl(fileUrl)) {
        const resolution = resolveWorldIdCoreRuntime();
        const body = await readFile(resolution.wasmPath);
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/wasm",
          },
        });
      }
      return await nativeFetch(input, init);
    }) as typeof fetch;
    globalThis.fetch = installedFetch;
  }
  fileFetchCompatDepth += 1;
  return () => {
    fileFetchCompatDepth = Math.max(0, fileFetchCompatDepth - 1);
    if (fileFetchCompatDepth !== 0) {
      return;
    }
    if (installedFetch && globalThis.fetch === installedFetch && originalFetch) {
      globalThis.fetch = originalFetch;
    }
    originalFetch = null;
    installedFetch = null;
  };
}

export async function withWorldIdCoreFileFetchCompat<T>(fn: () => Promise<T>): Promise<T> {
  const restore = installNodeFileFetchCompat();
  try {
    return await fn();
  } finally {
    restore();
  }
}

export async function loadWorldIdCoreRuntime(): Promise<WorldIdCoreRuntime> {
  worldIdCoreRuntimePromise ??= import(resolveWorldIdCoreRuntime().entrypoint);
  return await worldIdCoreRuntimePromise;
}
