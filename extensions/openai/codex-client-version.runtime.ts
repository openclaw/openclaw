import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENAI_CODEX_RESPONSES_BASE_URL } from "./base-url.js";

// Fallback when npm is unreachable. Keep synchronized with extensions/codex's
// exact @openai/codex dependency; the contract test fails when that pin changes.
const OPENAI_CODEX_CLIENT_VERSION = "0.160.0";
const CODEX_NPM_LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";
const CODEX_NPM_HOST = "registry.npmjs.org";
const CODEX_NPM_TIMEOUT_MS = 5_000;
const CODEX_NPM_MAX_BYTES = 1024 * 1024;
const CODEX_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
// Offline installs retry soon without sending one npm request per discovery.
const CODEX_VERSION_FAILURE_TTL_MS = 5 * 60 * 1000;
const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;
const RELEASE_PREFIX_PATTERN = /^(\d+)\.(\d+)\.(\d+)/u;

let cached: { version: string; expiresAt: number } | undefined;
let pending: Promise<string> | undefined;

function releaseParts(version: string): readonly number[] | undefined {
  const match = RELEASE_PREFIX_PATTERN.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
}

function isNewerRelease(candidate: string, current: string): boolean {
  const next = releaseParts(candidate);
  const base = releaseParts(current);
  if (!next || !base) {
    return false;
  }
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== base[index]) {
      return (next[index] ?? 0) > (base[index] ?? 0);
    }
  }
  return false;
}

async function fetchLatestCodexVersion(fetchGuard: LiveModelCatalogFetchGuard): Promise<string> {
  const { response, release } = await fetchGuard({
    url: CODEX_NPM_LATEST_URL,
    init: { headers: { Accept: "application/json" } },
    timeoutMs: CODEX_NPM_TIMEOUT_MS,
    policy: { hostnameAllowlist: [CODEX_NPM_HOST] },
    requireHttps: true,
    auditContext: "openai-codex-client-version",
  });
  try {
    if (!response.ok) {
      throw new Error(`npm returned HTTP ${response.status} for @openai/codex`);
    }
    const body = asOptionalRecord(
      await readProviderJsonResponse<unknown>(response, "npm @openai/codex", {
        chunkTimeoutMs: CODEX_NPM_TIMEOUT_MS,
        maxBytes: CODEX_NPM_MAX_BYTES,
      }),
    );
    const version = body?.version;
    if (typeof version !== "string" || !STABLE_VERSION_PATTERN.test(version)) {
      throw new Error("npm latest for @openai/codex is not a stable release version");
    }
    return version;
  } finally {
    await release();
  }
}

/**
 * ChatGPT model-list URL. The backend hides models whose minimum Codex version
 * is newer than `client_version`, so OpenClaw reports the newest stable Codex
 * release instead of waiting for its own pin to move.
 */
export async function resolveOpenAICodexModelsEndpoint(
  params: { fetchGuard?: LiveModelCatalogFetchGuard; now?: () => number } = {},
): Promise<string> {
  const version = await resolveClientVersion(params);
  return `${OPENAI_CODEX_RESPONSES_BASE_URL}/models?client_version=${encodeURIComponent(version)}`;
}

async function resolveClientVersion(
  params: { fetchGuard?: LiveModelCatalogFetchGuard; now?: () => number } = {},
): Promise<string> {
  const now = params.now ?? Date.now;
  if (cached && cached.expiresAt > now()) {
    return cached.version;
  }
  pending ??= fetchLatestCodexVersion(params.fetchGuard ?? fetchWithSsrFGuard)
    .then(
      (latest) => {
        // A newer pinned prerelease must not be hidden behind an older stable tag.
        const version = isNewerRelease(latest, OPENAI_CODEX_CLIENT_VERSION)
          ? latest
          : OPENAI_CODEX_CLIENT_VERSION;
        cached = { version, expiresAt: now() + CODEX_VERSION_TTL_MS };
        return version;
      },
      () => {
        // Keep the last npm answer; the bundled pin may hide models it already exposed.
        const version = cached?.version ?? OPENAI_CODEX_CLIENT_VERSION;
        cached = { version, expiresAt: now() + CODEX_VERSION_FAILURE_TTL_MS };
        return version;
      },
    )
    .finally(() => {
      pending = undefined;
    });
  return await pending;
}
