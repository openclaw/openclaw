/** One address-to-place owner shared by the HTTP and Gateway surfaces. */
import { isPrivateOrLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import type { GeolocationSettings } from "./config.js";
import type { GeolocationCityRecord, GeolocationDatabase } from "./database-store.js";

type GeolocationResult = {
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
};

export type GeolocationLookupResult = GeolocationResult & {
  ip: string;
  status: "found" | "not-found" | "unavailable";
  attribution: GeolocationSettings["attribution"];
};

export type GeolocationLookup = ReturnType<typeof createGeolocationLookup>;
type AssertCurrent = () => void | Promise<void>;

export function createGeolocationLookup(deps: {
  loadDatabase: () => Promise<GeolocationDatabase>;
  settings: GeolocationSettings;
  logger?: { warn: (msg: string) => void };
}) {
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
        database = await deps.loadDatabase();
      } catch (error) {
        deps.logger?.warn(
          `geolocation: lookup unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // A first lookup may await a database download; retain the original caller's
    // live authority before reading or publishing any result.
    await assertCurrent();
    const lookupAddress = (ip: string): GeolocationLookupResult => {
      const attribution = deps.settings.attribution;
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
        deps.logger?.warn(
          `geolocation: lookup unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { ip, status: "unavailable", attribution };
      }
    };
    return typeof input === "string" ? lookupAddress(input) : input.map(lookupAddress);
  }
  return lookup;
}

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
function projectGeolocationRecord(
  record: GeolocationCityRecord | null,
): GeolocationResult | undefined {
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
