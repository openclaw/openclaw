import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";

//#region src/agents/runtime-plugins.d.ts
declare function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void;
//#endregion
export { ensureRuntimePluginsLoaded as t };