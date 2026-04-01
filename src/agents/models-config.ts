import fs from "node:fs/promises";
import path from "node:path";
import {
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  type OpenClawConfig,
  loadConfig,
} from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { MODELS_JSON_STATE } from "./models-config-state.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";

export { resetModelsJsonReadyCacheForTest } from "./models-config-state.js";

async function readFileMtimeMs(pathname: string): Promise<number | null> {
  try {
    const stat = await fs.stat(pathname);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

async function buildModelsJsonFingerprint(params: {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
  agentDir: string;
}): Promise<string> {
  const authProfilesMtimeMs = await readFileMtimeMs(
    path.join(params.agentDir, "auth-profiles.json"),
  );
  const modelsFileMtimeMs = await readFileMtimeMs(path.join(params.agentDir, "models.json"));
  const envShape = createConfigRuntimeEnv(params.config, {});
  return stableStringify({
    config: params.config,
    sourceConfigForSecrets: params.sourceConfigForSecrets,
    envShape,
    authProfilesMtimeMs,
    modelsFileMtimeMs,
  });
}

async function readExistingModelsFile(pathname: string): Promise<{
  raw: string;
  parsed: unknown;
  readError: unknown;
}> {
  let raw: string;
  try {
    raw = await fs.readFile(pathname, "utf8");
  } catch (error) {
    if (!isMissingBootstrapSourceError(error)) {
      return {
        raw: "",
        parsed: null,
        readError: error,
      };
    }
    return {
      raw: "",
      parsed: null,
      readError: null,
    };
  }

  try {
    return {
      raw,
      parsed: JSON.parse(raw) as unknown,
      readError: null,
    };
  } catch {
    return {
      raw,
      parsed: null,
      readError: null,
    };
  }
}

export async function ensureModelsFileModeForModelsJson(pathname: string): Promise<void> {
  await fs.chmod(pathname, 0o600).catch(() => {
    // best-effort
  });
}

export async function writeModelsFileAtomicForModelsJson(
  targetPath: string,
  contents: string,
): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, contents, { mode: 0o600 });
  await fs.rename(tempPath, targetPath);
}

function isMissingBootstrapSourceError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function resolveModelsConfigInput(config?: OpenClawConfig): {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
} {
  const runtimeSource = getRuntimeConfigSourceSnapshot();
  if (!config) {
    const loaded = loadConfig();
    return {
      config: runtimeSource ?? loaded,
      sourceConfigForSecrets: runtimeSource ?? loaded,
    };
  }
  if (!runtimeSource) {
    return {
      config,
      sourceConfigForSecrets: config,
    };
  }
  const projected = projectConfigOntoRuntimeSourceSnapshot(config);
  return {
    config: projected,
    // If projection is skipped (for example incompatible top-level shape),
    // keep managed secret persistence anchored to the active source snapshot.
    sourceConfigForSecrets: projected === config ? runtimeSource : projected,
  };
}

async function withModelsJsonWriteLock<T>(targetPath: string, run: () => Promise<T>): Promise<T> {
  const prior = MODELS_JSON_STATE.writeLocks.get(targetPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prior.then(() => gate);
  MODELS_JSON_STATE.writeLocks.set(targetPath, pending);
  try {
    await prior;
    return await run();
  } finally {
    release();
    if (MODELS_JSON_STATE.writeLocks.get(targetPath) === pending) {
      MODELS_JSON_STATE.writeLocks.delete(targetPath);
    }
  }
}

export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
): Promise<{ agentDir: string; wrote: boolean }> {
  const resolved = resolveModelsConfigInput(config);
  const cfg = resolved.config;
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveOpenClawAgentDir();
  const targetPath = path.join(agentDir, "models.json");
  const fingerprint = await buildModelsJsonFingerprint({
    config: cfg,
    sourceConfigForSecrets: resolved.sourceConfigForSecrets,
    agentDir,
  });
  const cached = MODELS_JSON_STATE.readyCache.get(targetPath);
  if (cached) {
    const settled = await cached;
    if (settled.fingerprint === fingerprint) {
      await ensureModelsFileModeForModelsJson(targetPath);
      return settled.result;
    }
  }

  const pending = withModelsJsonWriteLock(targetPath, async () => {
    // Ensure config env vars (e.g. AWS_PROFILE, AWS_ACCESS_KEY_ID) are
    // are available to provider discovery without mutating process.env.
    const env = createConfigRuntimeEnv(cfg);
    const existingModelsFile = await readExistingModelsFile(targetPath);
    if (existingModelsFile.readError) {
      throw existingModelsFile.readError;
    }
    const plan = await planOpenClawModelsJson({
      cfg,
      sourceConfigForSecrets: resolved.sourceConfigForSecrets,
      agentDir,
      env,
      existingRaw: existingModelsFile.raw,
      existingParsed: existingModelsFile.parsed,
    });

    if (plan.action === "skip") {
      // When provider resolution is empty for a non-main agent, bootstrap
      // from the main agent's models.json so the model registry is not empty.
      const mainAgentDir = resolveOpenClawAgentDir();
      if (agentDir !== mainAgentDir) {
        if (existingModelsFile.raw.trim()) {
          await ensureModelsFileModeForModelsJson(targetPath);
          return { cacheable: true, fingerprint, result: { agentDir, wrote: false } };
        }

        const mainModelsPath = path.join(mainAgentDir, "models.json");
        let mainContents: string;
        try {
          mainContents = await fs.readFile(mainModelsPath, "utf-8");
        } catch (error) {
          if (isMissingBootstrapSourceError(error)) {
            // Retry after the main agent writes its bootstrap source file.
            return { cacheable: false, fingerprint, result: { agentDir, wrote: false } };
          }
          throw error;
        }

        if (mainContents.trim()) {
          if (existingModelsFile.raw === mainContents) {
            await ensureModelsFileModeForModelsJson(targetPath);
            return { cacheable: true, fingerprint, result: { agentDir, wrote: false } };
          }
          await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
          await writeModelsFileAtomicForModelsJson(targetPath, mainContents);
          await ensureModelsFileModeForModelsJson(targetPath);
          return { cacheable: true, fingerprint, result: { agentDir, wrote: true } };
        }
        // Main exists but is empty — retry after it gets populated.
        return { cacheable: false, fingerprint, result: { agentDir, wrote: false } };
      }
      return { cacheable: true, fingerprint, result: { agentDir, wrote: false } };
    }

    if (plan.action === "noop") {
      await ensureModelsFileModeForModelsJson(targetPath);
      return { cacheable: true, fingerprint, result: { agentDir, wrote: false } };
    }

    await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
    await writeModelsFileAtomicForModelsJson(targetPath, plan.contents);
    await ensureModelsFileModeForModelsJson(targetPath);
    return { cacheable: true, fingerprint, result: { agentDir, wrote: true } };
  });
  MODELS_JSON_STATE.readyCache.set(targetPath, pending);
  try {
    const settled = await pending;
    if (!settled.cacheable && MODELS_JSON_STATE.readyCache.get(targetPath) === pending) {
      MODELS_JSON_STATE.readyCache.delete(targetPath);
    }
    return settled.result;
  } catch (error) {
    if (MODELS_JSON_STATE.readyCache.get(targetPath) === pending) {
      MODELS_JSON_STATE.readyCache.delete(targetPath);
    }
    throw error;
  }
}
