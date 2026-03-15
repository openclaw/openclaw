import type { OpenClawConfig } from "../config/config.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { resolveUserPath } from "../utils.js";

export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
}): void {
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;

  loadOpenClawPlugins({
    config: params.config,
    workspaceDir,
  });
}
