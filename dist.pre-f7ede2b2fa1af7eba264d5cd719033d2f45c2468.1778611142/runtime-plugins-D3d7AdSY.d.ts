import { i as OpenClawConfig } from "./types.openclaw-BlE9q7jU.js";

//#region src/agents/runtime-plugins.d.ts
declare function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void;
//#endregion
export { ensureRuntimePluginsLoaded as t };