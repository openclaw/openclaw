// Shared User-Agent for xAI sidecar HTTP/WS requests; mirrors `formatOpenClawUserAgent`.

import { OPENCLAW_VERSION as PACKAGE_VERSION } from "openclaw/plugin-sdk/agent-harness-registration";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const ORIGINATOR = "openclaw";
const UNUSABLE_PACKAGE_VERSION = "0.0.0";
const FALLBACK_VERSION = "unknown";

function resolveXaiUserAgentVersion(): string {
  // Env-first matches resolveRuntimeServiceVersion.
  const envVersion = normalizeOptionalString(process.env.OPENCLAW_VERSION);
  if (envVersion) {
    return envVersion;
  }
  const packageVersion = normalizeOptionalString(PACKAGE_VERSION);
  if (packageVersion && packageVersion !== UNUSABLE_PACKAGE_VERSION) {
    return packageVersion;
  }
  return normalizeOptionalString(process.env.npm_package_version) ?? FALLBACK_VERSION;
}

export function xaiUserAgent(): string {
  return `${ORIGINATOR}/${resolveXaiUserAgentVersion()}`;
}

// Returns a `User-Agent` header entry only when the resolved baseUrl points
// at a verified xAI-native API host. User-configured proxy baseUrls produce
// an empty record so the openclaw identity is not forwarded to the proxy.
export function xaiUserAgentHeaderFor(baseUrl: string | undefined): Record<string, string> {
  if (baseUrl && URL.parse(baseUrl)?.hostname === "api.x.ai") {
    return { "User-Agent": xaiUserAgent() };
  }
  return {};
}
