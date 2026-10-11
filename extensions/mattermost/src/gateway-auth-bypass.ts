import { collectMattermostCallbackPaths } from "./mattermost/callback-host.js";

// Params shape is the core gateway-auth artifact contract: core invokes the
// public `gateway-auth-api.js` export as `resolveGatewayAuthBypassPaths({ cfg })`
// (src/channels/plugins/gateway-auth-bypass.ts), so a positional `cfg` param
// would silently drop configured callback paths on the pre-plugin fast path.
export function resolveMattermostGatewayAuthBypassPaths(params: {
  cfg: { channels?: Record<string, unknown> };
}): string[] {
  return collectMattermostCallbackPaths(params.cfg.channels?.mattermost).filter((path) =>
    path.startsWith("/api/channels/mattermost/"),
  );
}
