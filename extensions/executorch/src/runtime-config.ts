import os from "node:os";
import path from "node:path";
import { resolveExecuTorchModelPlugin } from "./models/registry.js";
import type { ExecuTorchModelPlugin } from "./models/types.js";
import type { RunnerBackend } from "./native-addon.js";

export type ExecuTorchPluginConfig = {
  enabled?: boolean;
  modelPlugin?: string;
  backend?: string;
  runtimeLibraryPath?: string;
  modelDir?: string;
  modelPath?: string;
  tokenizerPath?: string;
  dataPath?: string;
};

export type ResolvedExecuTorchRuntimeConfig = {
  modelPlugin: ExecuTorchModelPlugin;
  backend: RunnerBackend;
  modelRoot: string;
  modelDir: string;
  runtimeLibraryPath: string;
  modelPath: string;
  tokenizerPath: string;
  dataPath?: string;
  warnings: string[];
};

/**
 * Expands leading `~` / `~/` (Node does not) and resolves to an absolute path for fs access.
 */
export function normalizeExecuTorchPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const expanded = trimmed.startsWith("~")
    ? trimmed.replace(/^~(?=$|[\\/])/, os.homedir())
    : trimmed;
  return path.resolve(expanded);
}

export function resolveExecuTorchRuntimeConfig(
  rawConfig: ExecuTorchPluginConfig,
): ResolvedExecuTorchRuntimeConfig {
  const warnings: string[] = [];
  const resolvedModelPlugin = resolveExecuTorchModelPlugin(rawConfig.modelPlugin);
  if (resolvedModelPlugin.warning) {
    warnings.push(resolvedModelPlugin.warning);
  }
  const modelPlugin = resolvedModelPlugin.plugin;

  const backend = resolveBackend(rawConfig.backend, modelPlugin, warnings);
  const runtimeFromConfigOrEnv =
    rawConfig.runtimeLibraryPath?.trim() ||
    process.env.OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY?.trim() ||
    "";
  const runtimeLibraryPath = runtimeFromConfigOrEnv
    ? normalizeExecuTorchPath(runtimeFromConfigOrEnv)!
    : path.join(
        os.homedir(),
        ".openclaw/lib",
        modelPlugin.runtimeLibraryFileNameForPlatform(os.platform()),
      );

  const modelRootEnv = process.env.OPENCLAW_EXECUTORCH_MODEL_ROOT?.trim() || "";
  const modelRoot = modelRootEnv
    ? normalizeExecuTorchPath(modelRootEnv)!
    : path.join(os.homedir(), ".openclaw/models", modelPlugin.modelRootDirName);
  const modelDir =
    normalizeExecuTorchPath(rawConfig.modelDir?.trim()) ??
    path.join(modelRoot, modelPlugin.defaultModelDirName);
  const modelPath =
    normalizeExecuTorchPath(rawConfig.modelPath?.trim()) ??
    path.join(modelDir, modelPlugin.defaultModelFileName);
  const tokenizerPath =
    normalizeExecuTorchPath(rawConfig.tokenizerPath?.trim()) ??
    path.join(modelDir, modelPlugin.defaultTokenizerFileName);
  const dataPath = normalizeExecuTorchPath(rawConfig.dataPath) ?? undefined;

  return {
    modelPlugin,
    backend,
    modelRoot,
    modelDir,
    runtimeLibraryPath,
    modelPath,
    tokenizerPath,
    dataPath,
    warnings,
  };
}

function resolveBackend(
  requestedBackend: string | undefined,
  modelPlugin: ExecuTorchModelPlugin,
  warnings: string[],
): RunnerBackend {
  const defaultBackend = modelPlugin.supportedBackends[0];
  const requested = requestedBackend?.trim() as RunnerBackend | undefined;
  if (!requested) {
    return defaultBackend;
  }
  if (modelPlugin.supportedBackends.includes(requested)) {
    return requested;
  }
  warnings.push(
    `backend='${requestedBackend}' is not supported by modelPlugin='${modelPlugin.id}'; using '${defaultBackend}'.`,
  );
  return defaultBackend;
}
