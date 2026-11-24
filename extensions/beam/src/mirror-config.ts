import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { asFiniteNumber, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { clampNumber } from "openclaw/plugin-sdk/text-utility-runtime";

export const MIRROR_CONFIG_PATH = "plugins.entries.beam.config.mirror";
export const MIRROR_TOKEN_PATH = `${MIRROR_CONFIG_PATH}.token`;
const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_ACTIVE_WINDOW_MINUTES = 180;

function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

const MIRROR_KEYS = new Set([
  "endpoint",
  "token",
  "catalogs",
  "pollSeconds",
  "activeWindowMinutes",
]);

/** Returns the mirror config, undefined when mirroring is not configured, or an error string. */
export function parseBeamMirrorConfig(config: ReturnType<PluginRuntime["config"]["current"]>) {
  const mirror = config.plugins?.entries?.beam?.config?.mirror;
  if (mirror === undefined) {
    return undefined;
  }
  if (!isRecord(mirror) || !Object.keys(mirror).every((key) => MIRROR_KEYS.has(key))) {
    return `${MIRROR_CONFIG_PATH} must be a closed object with endpoint/token/catalogs/pollSeconds/activeWindowMinutes`;
  }
  const endpoint = typeof mirror.endpoint === "string" ? mirror.endpoint.trim() : "";
  const parsedEndpoint = URL.parse(endpoint);
  if (!parsedEndpoint) {
    return `${MIRROR_CONFIG_PATH}.endpoint must be an absolute URL`;
  }
  // Bearer credentials and transcripts must never cross the network in the
  // clear; plaintext HTTP is a loopback-development affordance only.
  if (parsedEndpoint.protocol === "http:") {
    if (!isLoopbackHostname(parsedEndpoint.hostname)) {
      return `${MIRROR_CONFIG_PATH}.endpoint must use https for non-loopback hosts`;
    }
  } else if (parsedEndpoint.protocol !== "https:") {
    return `${MIRROR_CONFIG_PATH}.endpoint must use http(s)`;
  }
  // Explicit per-catalog consent: an omitted or empty list mirrors nothing,
  // so one Beam setting can never silently export third-party catalogs.
  if (
    !Array.isArray(mirror.catalogs) ||
    mirror.catalogs.length === 0 ||
    !mirror.catalogs.every((id): id is string => typeof id === "string" && id.trim().length > 0)
  ) {
    return `${MIRROR_CONFIG_PATH}.catalogs must explicitly list the catalog ids to mirror`;
  }
  const normalizedPath = parsedEndpoint.pathname.replace(/\/$/, "");
  const apiV2 = normalizedPath.endsWith("/api/v2/beam");
  if (apiV2) {
    if (
      parsedEndpoint.username ||
      parsedEndpoint.password ||
      parsedEndpoint.search ||
      parsedEndpoint.hash
    ) {
      return `${MIRROR_CONFIG_PATH}.endpoint must name the final v2 receiver without user info, query, or fragment`;
    }
    parsedEndpoint.pathname = normalizedPath;
  }
  // The Gateway materializes refs to strings and leaves unavailable refs as objects.
  // null means configured but unavailable; undefined keeps tokenless receivers supported.
  const token =
    mirror.token === undefined
      ? undefined
      : typeof mirror.token === "string" && mirror.token.trim()
        ? mirror.token.trim()
        : null;
  return {
    endpoint: apiV2 ? parsedEndpoint.href : endpoint,
    apiV2,
    token,
    catalogs: mirror.catalogs.map((id) => id.trim().toLowerCase()),
    pollSeconds: clampNumber(asFiniteNumber(mirror.pollSeconds) ?? DEFAULT_POLL_SECONDS, 10, 3_600),
    activeWindowMinutes: clampNumber(
      asFiniteNumber(mirror.activeWindowMinutes) ?? DEFAULT_ACTIVE_WINDOW_MINUTES,
      1,
      10_080,
    ),
  };
}
