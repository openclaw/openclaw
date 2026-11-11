import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ensureOpenClawModelsJsonWithInput as ensureModelsJson,
  planOpenClawModelsJsonSourceWithInput as planModelsJsonSource,
} from "./models-config.core.js";

/** Ensures models.json and the agent SQLite catalog cache are current. */
export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: Parameters<typeof ensureModelsJson>[2] = {},
): ReturnType<typeof ensureModelsJson> {
  // Capture and invoke before yielding so default calls retain their original config and env.
  return ensureModelsJson(
    config ?? captureRuntimeConfigAsyncReader({ capture: true }),
    agentDirOverride,
    options,
  );
}

/** Plans the complete root/plugin catalog generation without mutating agent-owned state. */
export async function planOpenClawModelsJsonSource(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: Parameters<typeof planModelsJsonSource>[2] = {},
): ReturnType<typeof planModelsJsonSource> {
  return planModelsJsonSource(
    config ?? captureRuntimeConfigAsyncReader({ capture: true }),
    agentDirOverride,
    options,
  );
}
