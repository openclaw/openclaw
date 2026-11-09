/** Captures config before yielding, then delegates to the prepared catalog source owner. */
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  ensurePreparedModelsJson,
  planPreparedModelsJsonSource,
  prepareModelsConfigContext,
  resolveModelsConfigInput,
  type EnsureOpenClawModelsJsonOptions,
} from "./models-config.prepared.js";

async function captureModelsConfigContext(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
) {
  let ambientEnv = process.env;
  let resolved: ReturnType<typeof resolveModelsConfigInput>;
  if (config) {
    resolved = resolveModelsConfigInput(config);
  } else {
    const captured = await captureRuntimeConfigAsyncReader({ capture: true })();
    ambientEnv = captured.env;
    const source = projectConfigOntoRuntimeSourceSnapshot(captured.config);
    resolved = {
      config: source,
      discoveryAuthConfig: captured.config,
      sourceConfigForSecrets: source,
    };
  }
  return prepareModelsConfigContext(resolved, ambientEnv, agentDirOverride, options);
}

/** Ensures models.json and the agent SQLite catalog cache are current. */
export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
) {
  return ensurePreparedModelsJson(
    await captureModelsConfigContext(config, agentDirOverride, options),
  );
}

/** Plans captured source inputs without mutating agent-owned state. */
export async function planOpenClawModelsJsonSource(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions & { authStore?: AuthProfileStore } = {},
) {
  return planPreparedModelsJsonSource(
    await captureModelsConfigContext(config, agentDirOverride, options),
    options.authStore,
  );
}
