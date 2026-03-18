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
  const runtimeLibraryPath =
    rawConfig.runtimeLibraryPath?.trim() ||
    process.env.OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY?.trim() ||
    path.join(
      os.homedir(),
      ".openclaw/lib",
      modelPlugin.runtimeLibraryFileNameForPlatform(os.platform()),
    );

  const modelRoot =
    process.env.OPENCLAW_EXECUTORCH_MODEL_ROOT?.trim() ||
    path.join(os.homedir(), ".openclaw/models", modelPlugin.modelRootDirName);
  const modelDir =
    rawConfig.modelDir?.trim() || path.join(modelRoot, modelPlugin.defaultModelDirName);
  const modelPath =
    rawConfig.modelPath?.trim() || path.join(modelDir, modelPlugin.defaultModelFileName);
  const tokenizerPath =
    rawConfig.tokenizerPath?.trim() || path.join(modelDir, modelPlugin.defaultTokenizerFileName);
  const dataPath = rawConfig.dataPath?.trim() || undefined;

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
