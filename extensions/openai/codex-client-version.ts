import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// The subscription catalog's client_version follows Codex releases, independently
// of OpenClaw attribution and the selected app-server binary.

// Bundled @openai/codex pin: the floor when the registry cannot be read. The
// client-version contract test keeps it equal to extensions/codex's exact dependency.
const OPENAI_CODEX_CLIENT_VERSION_FLOOR = "0.169.0";

const CODEX_LATEST_VERSION_URL = "https://registry.npmjs.org/@openai/codex/latest";
const CODEX_LATEST_VERSION_TTL_MS = 6 * 60 * 60_000;
// Leave most of the selected-account discovery's five-second budget for /models.
const CODEX_LATEST_VERSION_TIMEOUT_MS = 1_000;
const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function compareStableVersions(left: string, right: string): number {
  const a = STABLE_VERSION.exec(left)!;
  const b = STABLE_VERSION.exec(right)!;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

async function fetchLatestCodexVersion(signal?: AbortSignal): Promise<string> {
  const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/ssrf-runtime");
  const { response, release } = await fetchWithSsrFGuard({
    url: CODEX_LATEST_VERSION_URL,
    timeoutMs: CODEX_LATEST_VERSION_TIMEOUT_MS,
    requireHttps: true,
    auditContext: "openai-codex-client-version",
    signal,
    init: { method: "GET", headers: { Accept: "application/json" } },
  });
  try {
    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status} for @openai/codex`);
    }
    const version = asOptionalRecord(await response.json())?.version;
    if (typeof version !== "string" || !STABLE_VERSION.test(version)) {
      throw new Error("npm registry returned no stable @openai/codex version");
    }
    return version;
  } finally {
    await release();
  }
}

/**
 * Codex client version OpenClaw reports when it lists ChatGPT subscription models:
 * the newest published stable Codex, never older than the bundled pin. A failed or
 * offline registry read keeps the pin and is retried on the next listing.
 */
export async function resolveOpenAICodexClientVersion(): Promise<string> {
  const { getCachedLiveCatalogValue } = await import("openclaw/plugin-sdk/provider-catalog-shared");
  try {
    const latest = await getCachedLiveCatalogValue({
      ttlMs: CODEX_LATEST_VERSION_TTL_MS,
      keyParts: ["openai", "codex-latest-client-version"],
      load: fetchLatestCodexVersion,
    });
    return compareStableVersions(latest, OPENAI_CODEX_CLIENT_VERSION_FLOOR) > 0
      ? latest
      : OPENAI_CODEX_CLIENT_VERSION_FLOOR;
  } catch {
    return OPENAI_CODEX_CLIENT_VERSION_FLOOR;
  }
}
