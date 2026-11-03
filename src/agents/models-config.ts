import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ensurePreparedModelsJson,
  planPreparedModelsJsonSource,
  prepareModelsConfigContext,
  resolveModelsConfigInput,
  type EnsureOpenClawModelsJsonOptions,
  type PlanOpenClawModelsJsonSourceOptions,
} from "./models-config.prepared.js";

async function prepareContext(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
) {
  if (config) {
    return prepareModelsConfigContext(
      resolveModelsConfigInput(config),
      process.env,
      agentDirOverride,
      options,
    );
  }
  // Start the canonical reader before yielding; it owns cold loads and published snapshots.
  // Prepared workers enter below this standalone boundary with their existing facts.
  const captured = await captureRuntimeConfigAsyncReader({ capture: true })();
  const source = projectConfigOntoRuntimeSourceSnapshot(captured.config);
  return prepareModelsConfigContext(
    { config: source, discoveryAuthConfig: captured.config, sourceConfigForSecrets: source },
    captured.env,
    agentDirOverride,
    options,
  );
}

/** Ensures models.json and the agent SQLite catalog cache are current. */
export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
) {
  return ensurePreparedModelsJson(prepareContext(config, agentDirOverride, options));
}

/** Plans a complete catalog generation without mutating agent-owned state. */
export async function planOpenClawModelsJsonSource(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: PlanOpenClawModelsJsonSourceOptions = {},
) {
  const { authStore } = options;
  return planPreparedModelsJsonSource(prepareContext(config, agentDirOverride, options), authStore);
}
