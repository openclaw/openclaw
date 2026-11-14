/**
 * Geolocation plugin entry. It exposes authenticated lookups and keeps
 * the database download lazy, so an install that nobody queries costs nothing.
 */
import net from "node:net";
import type { CityResponse } from "maxmind";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sendLengthFramedJson as sendJson } from "openclaw/plugin-sdk/http-response-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { isPrivateOrLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveGeolocationSettings, type GeolocationSettings } from "./src/config.js";
import { createGeolocationDatabaseStore, type GeolocationDatabase } from "./src/database-store.js";

type GeolocationResult = {
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
};

type GeolocationLookupResult = GeolocationResult & {
  ip: string;
  status: "found" | "not-found" | "unavailable";
  attribution: GeolocationSettings["attribution"];
};

type AssertCurrent = () => void | Promise<void>;

// The record type marks `en` required, but Lite builds do ship entries without
// it, so this reads defensively rather than trusting the declaration.
function englishName(names: { readonly en?: string } | undefined): string | undefined {
  const value = names?.en?.trim();
  return value ? value : undefined;
}

/**
 * Returns undefined when the database has no usable placement for the address,
 * so callers can distinguish "not found" from an empty-but-present answer.
 */
function projectGeolocationRecord(record: CityResponse | null): GeolocationResult | undefined {
  if (!record) {
    return undefined;
  }
  const result: GeolocationResult = {
    ...(englishName(record.city?.names) ? { city: englishName(record.city?.names) } : {}),
    ...(englishName(record.subdivisions?.[0]?.names)
      ? { region: englishName(record.subdivisions?.[0]?.names) }
      : {}),
    ...(englishName(record.country?.names) ? { country: englishName(record.country?.names) } : {}),
    ...(record.country?.iso_code ? { countryCode: record.country.iso_code } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

export default definePluginEntry({
  id: "geolocation",
  name: "Geolocation Plugin",
  description: "Bundled geolocation plugin",
  register(api) {
    const settings = resolveGeolocationSettings(api.pluginConfig);
    const store = createGeolocationDatabaseStore({
      stateDir: resolveStateDir(),
      settings,
      fetchImpl: fetch,
      logger: api.logger,
    });
    function lookup(ip: string, assertCurrent: AssertCurrent): Promise<GeolocationLookupResult>;
    function lookup(
      ips: readonly string[],
      assertCurrent: AssertCurrent,
    ): Promise<GeolocationLookupResult[]>;
    async function lookup(
      input: string | readonly string[],
      assertCurrent: AssertCurrent,
    ): Promise<GeolocationLookupResult | GeolocationLookupResult[]> {
      const ips = typeof input === "string" ? [input] : input;
      await assertCurrent();
      let database: GeolocationDatabase | undefined;
      if (ips.some((ip) => !isPrivateOrLoopbackHost(ip))) {
        try {
          database = await store.load();
        } catch (error) {
          api.logger?.warn(`geolocation: lookup unavailable: ${coerceErrorMessage(error)}`);
        }
      }
      // A first lookup may await a database download; retain the original caller's
      // live authority before reading or publishing any result.
      await assertCurrent();
      const lookupAddress = (ip: string): GeolocationLookupResult => {
        const attribution = settings.attribution;
        // Private/CGNAT addresses never need a database or trigger its download.
        if (isPrivateOrLoopbackHost(ip)) {
          return { ip, status: "not-found", attribution };
        }
        if (!database) {
          return { ip, status: "unavailable", attribution };
        }
        try {
          const location = projectGeolocationRecord(database.lookup(ip));
          return { ip, status: location ? "found" : "not-found", ...location, attribution };
        } catch (error) {
          api.logger?.warn(`geolocation: lookup unavailable: ${coerceErrorMessage(error)}`);
          return { ip, status: "unavailable", attribution };
        }
      };
      return typeof input === "string" ? lookupAddress(input) : input.map(lookupAddress);
    }
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
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.endsWith("/lookup")) {
          return false;
        }
        const ip = url.searchParams.get("ip")?.trim() ?? "";
        if (!net.isIP(ip)) {
          sendJson(res, 400, { error: "ip must be a valid IPv4 or IPv6 address" });
          return true;
        }
        const scope = getPluginRuntimeGatewayRequestScope();
        const result = await lookup(ip, async () => {
          await scope?.revalidate?.();
        });
        if (result.status === "unavailable") {
          sendJson(res, 503, { error: "geolocation database unavailable" });
        } else {
          const { ip: _ip, status, ...location } = result;
          sendJson(res, 200, {
            found: status === "found",
            ...location,
          });
        }
        return true;
      },
    });
  },
});
