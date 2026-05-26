import { r as AnyAgentTool } from "./common-BDN0bXby.js";
import { $ as OpenClawPluginService } from "./types-Vx7Jq4_-2.js";
import { i as GatewayRequestHandlers } from "./types-BMFYBAxt.js";
import { Type } from "typebox";

//#region extensions/browser/src/browser-tool.d.ts
declare function createBrowserTool(opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
}): AnyAgentTool;
//#endregion
//#region extensions/browser/src/gateway/browser-request.d.ts
declare function handleBrowserGatewayRequest({
  params,
  respond,
  context
}: Parameters<GatewayRequestHandlers["browser.request"]>[0]): Promise<void>;
declare const browserHandlers: GatewayRequestHandlers;
//#endregion
//#region extensions/browser/src/plugin-service.d.ts
declare function createBrowserPluginService(): OpenClawPluginService;
//#endregion
export { createBrowserTool as i, browserHandlers as n, handleBrowserGatewayRequest as r, createBrowserPluginService as t };