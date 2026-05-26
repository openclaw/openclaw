import { i as OpenClawConfig } from "../types.openclaw-BLF4DJTX.js";
import { n as SessionMcpRuntime, t as BundleMcpToolRuntime } from "../pi-bundle-mcp-types-CatnStso.js";

//#region src/agents/pi-bundle-mcp-materialize.d.ts
declare function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  reservedToolNames?: Iterable<string>;
  disposeRuntime?: () => Promise<void>;
}): Promise<BundleMcpToolRuntime>;
declare function createBundleMcpToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
  createRuntime?: (params: {
    sessionId: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => SessionMcpRuntime;
}): Promise<BundleMcpToolRuntime>;
//#endregion
export { createBundleMcpToolRuntime, materializeBundleMcpToolsForRun };