import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/agents/runtime-plugins.d.ts
declare function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void;
//#endregion
export { ensureRuntimePluginsLoaded as t };