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
 *   anthropic-ratelimit-unified-5h-utilization
 *   anthropic-ratelimit-unified-7d-utilization
 *   anthropic-ratelimit-unified-representative-claim
 *   (plus classic per-resource headers when present)
 *
 * The Anthropic Node SDK does not surface response headers to callers, and
 * pi-ai (the streaming layer) does not expose them either.  This module
 * works around that by **temporarily wrapping `globalThis.fetch`** for the
 * duration of a streaming request, capturing the headers from responses
 * whose URL matches `api.anthropic.com`, and restoring the original fetch
 * immediately after.
 *
 * ## Concurrency
 *
 * Multiple streaming calls may be in-flight concurrently (different sessions,
 * different lanes).  To avoid corrupting the fetch chain, this module uses a
 * **ref-counted singleton hook**: the first `install()` saves the original
 * fetch and installs the hook; subsequent installs increment the ref count.
 * Each `uninstall()` decrements the ref count; only the last one restores the
 * original fetch.  This ensures no broken chains regardless of interleaving.
 *
 * ## Output
 *
 * The latest headers are written to:
 *   `<stateDir>/anthropic-ratelimit.json`
 *
 * where `<stateDir>` defaults to `~/.openclaw/state` (configured via
 * `OPENCLAW_STATE_DIR` env var).  The file is overwritten atomically on
 * every API call with only the latest snapshot.  The `ts` field records
 * when the snapshot was captured; consumers should check staleness by
 * comparing `ts` to the current time.
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
 * The overhead is negligible: one JSON.stringify + one async file write
 * per API call.
 *
 * @module
 */

import fs from "node:fs/promises";
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

/**
 * Check whether a URL points to the Anthropic API.
 * Only matches `api.anthropic.com` to avoid false positives from
 * third-party proxies or Cloudflare AI Gateway URLs that happen to
 * contain "anthropic" in the hostname.
 */
function isAnthropicUrl(url: string | URL | Request): boolean {
  const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  return href.includes("api.anthropic.com");
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

// ── Async file writer (non-blocking) ────────────────────────────────────

/** Serialized async write queue to avoid blocking the event loop. */
let writeQueue = Promise.resolve();

/**
 * Asynchronously and atomically write the rate-limit snapshot to disk.
 * Uses write-to-temp + rename for crash safety.
 * Writes are serialized via a queue to avoid concurrent file operations.
 */
function writeSnapshotAsync(snapshot: RatelimitSnapshot, filePath: string): void {
  const json = safeJsonStringify(snapshot);
  if (!json) {
    return;
  }

  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;

  writeQueue = writeQueue
    .then(() => fs.mkdir(dir, { recursive: true }))
    .then(() => fs.writeFile(tmpPath, json + "\n", "utf-8"))
    .then(() => fs.rename(tmpPath, filePath))
    .catch((err) => {
      log.warn("failed to write ratelimit snapshot", { filePath, error: String(err) });
      // Best-effort cleanup of temp file
      fs.unlink(tmpPath).catch(() => {});
    });
}

// ── Ref-counted singleton fetch hook ────────────────────────────────────

let refCount = 0;
let savedOriginalFetch: typeof globalThis.fetch | null = null;

/**
 * The callback invoked when an Anthropic response is intercepted.
 * Set per-hook instance so each caller can tag its own sessionKey/modelId.
 */
type OnResponseCallback = (headers: Record<string, string>) => void;
const activeCallbacks = new Set<OnResponseCallback>();

function installGlobalHook(): void {
  if (refCount === 0) {
    savedOriginalFetch = globalThis.fetch;

    const hookedFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await savedOriginalFetch!(input, init);
      try {
        if (isAnthropicUrl(input as string | URL | Request)) {
          const rlHeaders = extractRatelimitHeaders(response);
          if (rlHeaders) {
            // Notify all active callbacks
            for (const cb of activeCallbacks) {
              try {
                cb(rlHeaders);
              } catch {
                // never break the response chain
              }
            }
          }
        }
      } catch (err) {
        log.warn("error capturing ratelimit headers", { error: String(err) });
      }
      return response;
    };

    globalThis.fetch = hookedFetch;
  }
  refCount++;
}

function uninstallGlobalHook(): void {
  refCount--;
  if (refCount <= 0) {
    refCount = 0;
    if (savedOriginalFetch) {
      globalThis.fetch = savedOriginalFetch;
      savedOriginalFetch = null;
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
 * - Only intercepts responses from `api.anthropic.com` URLs
 * - Does not modify request or response in any way
 * - Uses ref-counted singleton to handle concurrent calls safely
 * - Restores original fetch only when the last hook uninstalls
 */
export function createRatelimitFetchHook(params: {
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  modelId?: string;
}): { install: () => void; uninstall: () => void } {
  const env = params.env ?? process.env;
  const snapshotPath = resolveSnapshotPath(env);
  let installed = false;

  const onResponse: OnResponseCallback = (rlHeaders) => {
    const snapshot: RatelimitSnapshot = {
      ts: new Date().toISOString(),
      headers: rlHeaders,
      sessionKey: params.sessionKey,
      modelId: params.modelId,
    };
    writeSnapshotAsync(snapshot, snapshotPath);
    log.debug("captured ratelimit headers", {
      sessionKey: params.sessionKey,
      headerCount: Object.keys(rlHeaders).length,
    });
  };

  const install = () => {
    if (installed) {
      return;
    }
    installed = true;
    activeCallbacks.add(onResponse);
    installGlobalHook();
  };

  const uninstall = () => {
    if (!installed) {
      return;
    }
    installed = false;
    activeCallbacks.delete(onResponse);
    uninstallGlobalHook();
  };

  return { install, uninstall };
}

/**
 * Read the latest rate-limit snapshot from disk.
 * Returns `null` if the file does not exist or cannot be parsed.
 *
 * Note: the snapshot reflects the state at the time of the last API call.
 * If the gateway has been idle, the `ts` field may be stale. Consumers
 * should compare `ts` to the current time to assess freshness.
 */
export function readRatelimitSnapshot(env?: NodeJS.ProcessEnv): RatelimitSnapshot | null {
  // Use synchronous read for consumer convenience (called from dashboard tools)
  const filePath = resolveSnapshotPath(env);
  try {
    // eslint-disable-next-line no-restricted-syntax
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as RatelimitSnapshot;
  } catch {
    return null;
  }
}
