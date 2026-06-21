/** Small runtime-only Codex thread config boundary shared by isolated turns. */
import type { JsonObject } from "./protocol.js";

// Stream structured patch snapshots so large generated edits keep the turn active.
const CODEX_CODE_MODE_THREAD_CONFIG: JsonObject = {
  "features.code_mode": true,
  "features.code_mode_only": false,
  "features.apply_patch_streaming_events": true,
};

const CODEX_CODE_MODE_DISABLED_THREAD_CONFIG: JsonObject = {
  "features.code_mode": false,
  "features.code_mode_only": false,
};

/** Applies native code-mode policy without loading the full thread lifecycle. */
export function buildCodexRuntimeThreadConfig(
  config: JsonObject | undefined,
  options: { nativeCodeModeEnabled?: boolean; nativeCodeModeOnlyEnabled?: boolean } = {},
): JsonObject {
  const codeModeConfig: JsonObject = {
    ...CODEX_CODE_MODE_THREAD_CONFIG,
    "features.code_mode_only": options.nativeCodeModeOnlyEnabled === true,
  };
  if (options.nativeCodeModeEnabled === false) {
    const disabledConfig = { ...config, ...CODEX_CODE_MODE_DISABLED_THREAD_CONFIG };
    // Patch streaming belongs to native code mode; omit it when that tool surface is disabled.
    delete disabledConfig["features.apply_patch_streaming_events"];
    return disabledConfig;
  }
  if (options.nativeCodeModeOnlyEnabled === true) {
    return { ...codeModeConfig, ...config, "features.code_mode_only": true };
  }
  return { ...codeModeConfig, ...config };
}
