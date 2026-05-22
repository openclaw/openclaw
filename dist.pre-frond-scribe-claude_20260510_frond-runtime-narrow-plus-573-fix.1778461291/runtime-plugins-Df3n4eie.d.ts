import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";

//#region src/agents/runtime-plugins.d.ts
declare function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void;
//#endregion
export { ensureRuntimePluginsLoaded as t };