/**
 * Captures Anthropic rate-limit response headers (`anthropic-ratelimit-*`)
 * and writes them to a well-known JSON file so external tools (dashboards,
 * CLI scripts, budget trackers) can read the current rate-limit state.
 *
 * ## Why this exists
 *
 * Anthropic returns rate-limit information in HTTP response headers for every
 * API call.  For users on Claude Max (subscription/OAuth), there is **no
 * programmatic API** to query remaining quota (session limits, weekly caps,
 * extra-usage budget).  The only machine-readable signal is these headers:
 *
 *   anthropic-ratelimit-unified-limit
 *   anthropic-ratelimit-unified-remaining
 *   anthropic-ratelimit-unified-reset
 *   anthropic-ratelimit-unified-tokens-limit
 *   anthropic-ratelimit-unified-tokens-remaining
 *   anthropic-ratelimit-unified-tokens-reset
 *   (plus classic per-resource headers when present)
 *
 * The Anthropic Node SDK does not surface response headers to callers, and
 * pi-ai (the streaming layer) does not expose them either.  This module
 * works around that by **temporarily wrapping `globalThis.fetch`** for the
 * duration of a streaming request, capturing the headers from responses
 * whose URL matches `api.anthropic.com`, and restoring the original fetch
 * immediately after.
 *
 * ## Output
 *
 * The latest headers are written to:
 *   `<stateDir>/anthropic-ratelimit.json`
 *
 * File format:
 * ```json
 * {
 *   "ts": "2025-02-18T14:30:00.000Z",
 *   "headers": {
 *     "anthropic-ratelimit-unified-limit": "...",
 *     "anthropic-ratelimit-unified-remaining": "...",
 *     ...
 *   },
 *   "sessionKey": "...",
 *   "modelId": "..."
 * }
 * ```
 *
 * ## Activation
 *
 * Always active for Anthropic models.  No env-var opt-in required.
 * The overhead is negligible: one JSON.stringify + one atomic file write
 * per API call.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { safeJsonStringify } from "../utils/safe-json.js";

const log = createSubsystemLogger("agent/anthropic-ratelimit");

/** Header prefixes we capture. */
const RATELIMIT_HEADER_PREFIXES = ["anthropic-ratelimit-", "retry-after", "x-ratelimit-"];

function isRatelimitHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return RATELIMIT_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isAnthropicUrl(url: string | URL | Request): boolean {
  const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  return href.includes("api.anthropic.com") || href.includes("anthropic");
}

export type RatelimitSnapshot = {
  ts: string;
  headers: Record<string, string>;
  sessionKey?: string;
  modelId?: string;
};

/**
 * Extract rate-limit headers from a `Response` object.
 * Returns `null` if no rate-limit headers are present.
 */
function extractRatelimitHeaders(response: Response): Record<string, string> | null {
  const headers: Record<string, string> = {};
  let found = false;
  response.headers.forEach((value, name) => {
    if (isRatelimitHeader(name)) {
      headers[name.toLowerCase()] = value;
      found = true;
    }
  });
  return found ? headers : null;
}

function resolveSnapshotPath(env?: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env ?? process.env), "anthropic-ratelimit.json");
}

/**
 * Atomically write the rate-limit snapshot to disk.
 * Uses write-to-temp + rename for crash safety.
 */
function writeSnapshot(snapshot: RatelimitSnapshot, filePath: string): void {
  const json = safeJsonStringify(snapshot);
  if (!json) {
    return;
  }

  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // directory likely exists
  }

  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, json + "\n", "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    log.warn("failed to write ratelimit snapshot", { filePath, error: String(err) });
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

/**
 * Create a scoped fetch wrapper that intercepts Anthropic API responses
 * and captures rate-limit headers.
 *
 * Usage:
 * ```ts
 * const { install, uninstall } = createRatelimitFetchHook({ sessionKey, modelId });
 * install();
 * try {
 *   // ... streaming API call happens here ...
 * } finally {
 *   uninstall();
 * }
 * ```
 *
 * The wrapper is designed to be safe:
 * - Only intercepts responses from Anthropic URLs
 * - Does not modify request or response in any way
 * - Restores original fetch on `uninstall()`
 * - Handles concurrent installs via reference counting
 */
export function createRatelimitFetchHook(params: {
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  modelId?: string;
}): { install: () => void; uninstall: () => void } {
  const env = params.env ?? process.env;
  const snapshotPath = resolveSnapshotPath(env);
  let originalFetch: typeof globalThis.fetch | null = null;
  let installed = false;

  const install = () => {
    if (installed) {
      return;
    }
    installed = true;
    originalFetch = globalThis.fetch;

    const hookedFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await originalFetch!(input, init);
      try {
        if (isAnthropicUrl(input as string | URL | Request)) {
          const rlHeaders = extractRatelimitHeaders(response);
          if (rlHeaders) {
            const snapshot: RatelimitSnapshot = {
              ts: new Date().toISOString(),
              headers: rlHeaders,
              sessionKey: params.sessionKey,
              modelId: params.modelId,
            };
            writeSnapshot(snapshot, snapshotPath);
            log.debug("captured ratelimit headers", {
              sessionKey: params.sessionKey,
              headerCount: Object.keys(rlHeaders).length,
            });
          }
        }
      } catch (err) {
        // Never let header capture break the actual API call
        log.warn("error capturing ratelimit headers", { error: String(err) });
      }
      return response;
    };

    globalThis.fetch = hookedFetch;
  };

  const uninstall = () => {
    if (!installed) {
      return;
    }
    installed = false;
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
    }
  };

  return { install, uninstall };
}

/**
 * Read the latest rate-limit snapshot from disk.
 * Returns `null` if the file does not exist or cannot be parsed.
 */
export function readRatelimitSnapshot(env?: NodeJS.ProcessEnv): RatelimitSnapshot | null {
  const filePath = resolveSnapshotPath(env);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as RatelimitSnapshot;
  } catch {
    return null;
  }
}
