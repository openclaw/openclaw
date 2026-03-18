import { PARAKEET_MODEL_PLUGIN } from "./parakeet.js";
import type { ExecuTorchModelPlugin } from "./types.js";

export const DEFAULT_MODEL_PLUGIN_ID = PARAKEET_MODEL_PLUGIN.id;

const MODEL_PLUGINS: Record<string, ExecuTorchModelPlugin> = {
  [PARAKEET_MODEL_PLUGIN.id]: PARAKEET_MODEL_PLUGIN,
};

export function listExecuTorchModelPlugins(): ExecuTorchModelPlugin[] {
  return Object.values(MODEL_PLUGINS);
}

export function resolveExecuTorchModelPlugin(requestedId: string | undefined): {
  plugin: ExecuTorchModelPlugin;
  warning?: string;
} {
  const normalized = requestedId?.trim().toLowerCase();
  if (!normalized) {
    return { plugin: MODEL_PLUGINS[DEFAULT_MODEL_PLUGIN_ID] };
  }
  const plugin = MODEL_PLUGINS[normalized];
  if (plugin) {
    return { plugin };
  }
  return {
    plugin: MODEL_PLUGINS[DEFAULT_MODEL_PLUGIN_ID],
    warning: `unknown modelPlugin='${requestedId}'. Falling back to '${DEFAULT_MODEL_PLUGIN_ID}'.`,
  };
}
