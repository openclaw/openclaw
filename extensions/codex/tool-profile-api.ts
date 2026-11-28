import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { readCodexPluginConfig } from "./src/app-server/config-parsing.js";
import { filterCodexDynamicTools } from "./src/app-server/dynamic-tool-profile.js";

/** Projects supplied dynamic tools through the same policy used by Codex turns. */
export function filterDynamicToolNames(names: readonly string[], config: OpenClawConfig): string[] {
  return filterCodexDynamicTools(
    names.map((name) => ({ name })),
    readCodexPluginConfig(resolvePluginConfigObject(config, "codex")),
  ).map((tool) => tool.name);
}
