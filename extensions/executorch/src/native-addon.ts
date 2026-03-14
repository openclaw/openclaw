import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RunnerBackend = "metal";

type NativeRunnerHandle = object;

export type NativeRunnerCreateConfig = {
  runtimeLibraryPath: string;
  backend: RunnerBackend;
  modelPath: string;
  tokenizerPath: string;
  dataPath?: string;
  warmup?: boolean;
};

type NativeTranscribeOptions = {
  maxNewTokens?: number;
  temperature?: number;
};

export type NativeExecuTorchAddon = {
  createRunner(config: NativeRunnerCreateConfig): NativeRunnerHandle;
  destroyRunner(handle: NativeRunnerHandle): void;
  transcribe(
    handle: NativeRunnerHandle,
    pcmBuffer: Buffer,
    options?: NativeTranscribeOptions,
  ): string;
};

let cachedAddon: NativeExecuTorchAddon | null = null;

function candidateAddonPaths(): string[] {
  const envPath = process.env.OPENCLAW_EXECUTORCH_NATIVE_ADDON?.trim();
  const here = path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    envPath,
    path.join(here, "..", "build", "Release", "parakeet_runtime.node"),
    path.join(here, "..", "..", "build", "Release", "parakeet_runtime.node"),
    path.join(here, "..", "native", "build", "Release", "parakeet_runtime.node"),
    path.join(here, "..", "..", "native", "build", "Release", "parakeet_runtime.node"),
  ].filter((p): p is string => Boolean(p));

  return [...new Set(candidates)];
}

export function loadNativeExecuTorchAddon(): NativeExecuTorchAddon {
  if (cachedAddon) {
    return cachedAddon;
  }

  const require = createRequire(import.meta.url);
  const errors: string[] = [];

  for (const candidate of candidateAddonPaths()) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const mod = require(candidate) as NativeExecuTorchAddon;
      if (
        typeof mod?.createRunner === "function" &&
        typeof mod?.destroyRunner === "function" &&
        typeof mod?.transcribe === "function"
      ) {
        cachedAddon = mod;
        return mod;
      }
      errors.push(`addon loaded but API mismatch at ${candidate}`);
    } catch (error) {
      errors.push(
        `failed to load addon at ${candidate}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const detail = errors.length > 0 ? `\n${errors.join("\n")}` : "";
  throw new Error(
    "Parakeet native addon not found. Build it with `npm install` inside `extensions/executorch` or set OPENCLAW_EXECUTORCH_NATIVE_ADDON." +
      detail,
  );
}
