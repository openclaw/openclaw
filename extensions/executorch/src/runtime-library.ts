import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PluginLogger } from "openclaw/plugin-sdk/executorch";

const execFileAsync = promisify(execFile);

const LEGACY_LIBOMP_PATH = "/opt/llvm-openmp/lib/libomp.dylib";
const LIBOMP_OVERRIDE_ENV = "OPENCLAW_EXECUTORCH_LIBOMP_PATH";
const LIBOMP_REWRITE_SKIP_ENV = "OPENCLAW_EXECUTORCH_SKIP_LIBOMP_REWRITE";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readLinkedLibraries(runtimeLibraryPath: string): Promise<string> {
  const { stdout } = await execFileAsync("otool", ["-L", runtimeLibraryPath], {
    timeout: 15_000,
  });
  return stdout;
}

async function runtimeReferencesPath(
  runtimeLibraryPath: string,
  dependencyPath: string,
): Promise<boolean> {
  try {
    const linkedLibraries = await readLinkedLibraries(runtimeLibraryPath);
    return linkedLibraries.includes(dependencyPath);
  } catch {
    return false;
  }
}

async function resolveLibompReplacementPath(): Promise<string | null> {
  const overridePath = process.env[LIBOMP_OVERRIDE_ENV]?.trim();
  const candidates = [
    overridePath,
    process.env.CONDA_PREFIX
      ? path.join(process.env.CONDA_PREFIX, "lib", "libomp.dylib")
      : undefined,
    "/opt/homebrew/opt/libomp/lib/libomp.dylib",
    "/usr/local/opt/libomp/lib/libomp.dylib",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function ensureRuntimeLibraryLoadable(
  runtimeLibraryPath: string,
  logger?: PluginLogger,
): Promise<void> {
  if (process.platform !== "darwin") return;
  if (process.env[LIBOMP_REWRITE_SKIP_ENV]?.trim() === "1") return;

  const referencesLegacyPath = await runtimeReferencesPath(runtimeLibraryPath, LEGACY_LIBOMP_PATH);
  if (!referencesLegacyPath) return;

  if (await fileExists(LEGACY_LIBOMP_PATH)) return;

  const replacementPath = await resolveLibompReplacementPath();
  if (!replacementPath) {
    throw new Error(
      `Runtime library depends on missing ${LEGACY_LIBOMP_PATH}. ` +
        `Install libomp (brew install libomp) or set ${LIBOMP_OVERRIDE_ENV} to a valid libomp.dylib path.`,
    );
  }

  try {
    await execFileAsync(
      "install_name_tool",
      ["-change", LEGACY_LIBOMP_PATH, replacementPath, runtimeLibraryPath],
      { timeout: 15_000 },
    );
  } catch (error) {
    throw new Error(
      `Failed to patch runtime dependency from ${LEGACY_LIBOMP_PATH} to ${replacementPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  logger?.warn(
    `[executorch] Patched runtime dependency: ${LEGACY_LIBOMP_PATH} -> ${replacementPath}`,
  );
}
