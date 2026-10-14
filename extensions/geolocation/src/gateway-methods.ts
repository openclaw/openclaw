import net from "node:net";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { GeolocationLookup } from "./lookup.js";

export function registerGeolocationGatewayMethods(
  api: OpenClawPluginApi,
  lookup: GeolocationLookup,
): void {
  api.registerGatewayMethod(
    "geolocation.lookup",
    async (options) => {
      const { params, respond } = options;
      if (
        Object.keys(params).some((key) => key !== "ips") ||
        !Array.isArray(params.ips) ||
        params.ips.length > 200 ||
        !params.ips.every((ip): ip is string => typeof ip === "string" && net.isIP(ip) !== 0)
      ) {
        const { ErrorCodes, errorShape } = await import("openclaw/plugin-sdk/gateway-runtime");
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "ips must contain at most 200 IPv4 or IPv6 addresses",
          ),
        );
        return;
      }
      const assertCurrent = () => {
        options.signal?.throwIfAborted();
        if (options.client?.invalidated || options.hasCurrentClientAuthority?.() === false) {
          throw new Error("Gateway requester authority changed");
        }
        options.sessionMutationCommitGuard?.();
        options.sessionMutationAuthorization?.assertCurrent();
      };
      const results = await lookup([...new Set(params.ips)], assertCurrent);
      assertCurrent();
      respond(true, { results });
    },
    { scope: "operator.read", profileAccess: "independent" },
  );
}
