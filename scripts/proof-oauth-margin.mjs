/**
 * Runtime proof for PR #105070 (issue #103846).
 *
 * Repo builds with tsgo/oxc, not esbuild, so real src modules can't be tsx'd
 * here (masked type tokens). This script faithfully copies the EXACT decision
 * functions from the committed diff:
 *   - src/agents/auth-profiles/credential-state.ts: resolveTokenExpiryState,
 *     hasUsableOAuthCredential (with access + margin check)
 *   - src/llm/utils/oauth/index.ts: old vs new getOAuthApiKey refresh gate
 * The real code path is also covered by index.test.ts (vitest, repo transform).
 *
 * Run: node scripts/proof-oauth-margin.mjs
 */

const MAX_DATE_TIMESTAMP_MS = 8640000000000000;
const DEFAULT_OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function resolveTokenExpiryState(expires, now = Date.now(), opts) {
  if (expires === undefined) return "missing";
  if (typeof expires !== "number") return "invalid_expires";
  if (!Number.isFinite(expires) || expires <= 0 || expires > MAX_DATE_TIMESTAMP_MS) return "invalid_expires";
  const remainingMs = expires - now;
  if (remainingMs <= 0) return "expired";
  const expiringWithinMs = Math.max(0, opts?.expiringWithinMs ?? 0);
  if (expiringWithinMs > 0 && remainingMs <= expiringWithinMs) return "expiring";
  return "valid";
}

function hasUsableOAuthCredential(credential, opts) {
  if (!credential || credential.type !== "oauth") return false;
  if (typeof credential.access !== "string" || credential.access.trim().length === 0) return false;
  const now = opts?.now ?? Date.now();
  const refreshMarginMs = Math.max(0, opts?.refreshMarginMs ?? DEFAULT_OAUTH_REFRESH_MARGIN_MS);
  return resolveTokenExpiryState(credential.expires, now, { expiringWithinMs: refreshMarginMs }) === "valid";
}

// OLD getOAuthApiKey gate (pre-fix): raw expiry only
const oldRefresh = (creds, now) => now >= creds.expires;
// NEW getOAuthApiKey gate (post-fix): margin-aware via hasUsableOAuthCredential
const newRefresh = (creds, now) => !hasUsableOAuthCredential(creds, { now });

function run() {
  const now = Date.now();
  const withinMarginExpires = now + 2 * 60 * 1000; // 2 min out -> inside 5min margin
  const creds = { type: "oauth", access: "old-token", expires: withinMarginExpires };

  const usable = hasUsableOAuthCredential(creds, { now });
  const oldR = oldRefresh(creds, now);
  const newR = newRefresh(creds, now);

  console.log(`MARGIN_MS=${DEFAULT_OAUTH_REFRESH_MARGIN_MS}`);
  console.log(`creds.expires - now = ${withinMarginExpires - now} ms (inside margin)`);
  console.log(`hasUsableOAuthCredential = ${usable} (manager gate: ${usable ? "USE CACHED" : "REFRESH"})`);
  console.log(`OLD getOAuthApiKey refresh? ${oldR}  -> returns unchanged creds (STALE TOKEN)`);
  console.log(`NEW getOAuthApiKey refresh? ${newR}  -> refreshes within margin (FRESH TOKEN)`);

  const fixed = !usable && oldR === false && newR === true;
  console.log(`\nRESULT: ${fixed ? "PASS — within margin, OLD skipped refresh (bug) but NEW refreshes (fixed)" : "FAIL"}`);
  if (!fixed) process.exit(1);
}

run();
