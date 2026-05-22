import { i as OpenClawConfig } from "./types.openclaw-DZQrhn8E.js";

//#region src/agents/runtime-plugins.d.ts
declare function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void;
//#endregion
export { ensureRuntimePluginsLoaded as t };