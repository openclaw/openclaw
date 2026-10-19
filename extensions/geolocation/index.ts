/**
 * Geolocation plugin entry. It exposes authenticated lookups and keeps
 * the database download lazy, so an install that nobody queries costs nothing.
 */
import net from "node:net";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveGeolocationSettings } from "./src/config.js";
import { createGeolocationDatabaseStore } from "./src/database-store.js";
import { createGeolocationLookupHandler } from "./src/lookup-route.js";
import { createGeolocationLookup } from "./src/lookup.js";

export default definePluginEntry({
  id: "geolocation",
  name: "Geolocation Plugin",
  description: "Bundled geolocation plugin",
  register(api) {
    const settings = resolveGeolocationSettings(api.pluginConfig);
    const store = createGeolocationDatabaseStore({
      stateDir: resolveStateDir(),
      settings,
      now: () => new Date(),
      fetchImpl: fetch,
      logger: api.logger,
    });
    const lookup = createGeolocationLookup({
      loadDatabase: () => store.load(),
      settings,
      logger: api.logger,
    });
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
    api.registerHttpRoute({
      path: "/plugins/geolocation",
      auth: "gateway",
      match: "prefix",
      handler: createGeolocationLookupHandler(lookup),
    });
  },
});
