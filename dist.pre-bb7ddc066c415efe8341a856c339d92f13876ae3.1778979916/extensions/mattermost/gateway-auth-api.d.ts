//#region extensions/mattermost/src/gateway-auth-bypass.d.ts
declare function resolveMattermostGatewayAuthBypassPaths(cfg: {
  channels?: Record<string, unknown>;
}): string[];
//#endregion
export { resolveMattermostGatewayAuthBypassPaths as resolveGatewayAuthBypassPaths };