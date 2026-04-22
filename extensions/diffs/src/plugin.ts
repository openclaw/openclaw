import path from "node:path";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/config-runtime";
import { resolvePreferredOpenClawTmpDir, type OpenClawPluginApi } from "../api.js";
import {
  resolveDiffsPluginDefaults,
  resolveDiffsPluginSecurity,
  resolveDiffsPluginViewerBaseUrl,
} from "./config.js";
import { createDiffsHttpHandler } from "./http.js";
import { DIFFS_AGENT_GUIDANCE } from "./prompt-guidance.js";
import { DiffArtifactStore } from "./store.js";
import { createDiffsTool } from "./tool.js";

export function registerDiffsPlugin(api: OpenClawPluginApi): void {
  const defaults = resolveDiffsPluginDefaults(api.pluginConfig);
  const viewerBaseUrl = resolveDiffsPluginViewerBaseUrl(api.pluginConfig);
  const store = new DiffArtifactStore({
    rootDir: path.join(resolvePreferredOpenClawTmpDir(), "openclaw-diffs"),
    logger: api.logger,
  });
  const resolveCurrentAccessConfig = () => {
    const currentConfig = api.runtime.config?.loadConfig?.() ?? api.config;
    const pluginConfig = resolvePluginConfigObject(currentConfig, "diffs") ?? api.pluginConfig;
    return {
      allowRemoteViewer: resolveDiffsPluginSecurity(pluginConfig).allowRemoteViewer,
      trustedProxies: currentConfig.gateway?.trustedProxies,
      allowRealIpFallback: currentConfig.gateway?.allowRealIpFallback === true,
    };
  };

  api.registerTool(
    (ctx) => createDiffsTool({ api, store, defaults, viewerBaseUrl, context: ctx }),
    {
      name: "diffs",
    },
  );
  api.registerHttpRoute({
    path: "/plugins/diffs",
    auth: "plugin",
    match: "prefix",
    handler: createDiffsHttpHandler({
      store,
      logger: api.logger,
      allowRemoteViewer: resolveDiffsPluginSecurity(api.pluginConfig).allowRemoteViewer,
      trustedProxies: api.config.gateway?.trustedProxies,
      allowRealIpFallback: api.config.gateway?.allowRealIpFallback === true,
      resolveAccessConfig: resolveCurrentAccessConfig,
    }),
  });
  api.on("before_prompt_build", async () => ({
    prependSystemContext: DIFFS_AGENT_GUIDANCE,
  }));
}
