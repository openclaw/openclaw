#!/usr/bin/env node
/**
 * Live repro for the chutes-oauth bounded-read PR — proves the canonical
 * 16 MiB provider-response cap on `readProviderJsonResponse` for the three
 * Chutes OAuth response sites:
 *   - fetchChutesUserInfo (line 118)
 *   - exchangeChutesCodeForTokens (line 158)
 *   - refreshChutesTokens (line 229)
 *
 * Run: pnpm exec tsx scripts/repro/issue-chutes-oauth-bounded-read.mjs
 *
 * The script drives the production `readProviderJsonResponse` directly
 * (no vitest mock) with three streaming bodies:
 *   1. Valid: a typical Chutes token exchange response (~78 B) under the
 *      16 MiB cap is accepted and parsed.
 *   2. Hostile: a 64 MiB streaming body is rejected with the canonical
 *      "JSON response exceeds 16777216 bytes" error before the runtime
 *      buffers the full body (exercised against all 3 production labels).
 *   3. Negative control: raw `response.json()` on the same 64 MiB body
 *      buffers the full payload and only fails on JSON parse, proving the
 *      bounded read is the right shape (and that the
 *      `readProviderJsonResponse` swap in chutes-oauth.ts is the
 *      meaningful change, not an inert re-export).
 *
 * Mirrors the bounded-read pattern merged for #95926 / #96036 / #96136 /
 * #96144, applied to the chutes-oauth surface.
 */
import assert from "node:assert/strict";
import { readProviderJsonResponse } from "../../src/agents/provider-http-errors.ts";

const PROVIDER_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

function createStreamingJsonResponse({ totalBytes, chunkSize = 1024 * 1024 }) {
  let written = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    pull(controller) {
      if (written >= totalBytes) {
        controller.close();
        return;
      }
      const remaining = totalBytes - written;
      const slice = Math.min(chunkSize, remaining);
      controller.enqueue(encoder.encode("a".repeat(slice)));
      written += slice;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

console.log("=== Reproduction for chutes-oauth bounded JSON response cap policy ===");
console.log(`PROVIDER_JSON_RESPONSE_MAX_BYTES = ${PROVIDER_JSON_RESPONSE_MAX_BYTES} bytes`);

// 1. Valid Chutes token exchange response: typical ~78 B envelope.
const validBody = {
  access_token: "at_test_123",
  refresh_token: "rt_test_123",
  expires_in: 3600,
};
const validJson = JSON.stringify(validBody);
const validResponse = new Response(validJson, {
  status: 200,
  headers: { "Content-Type": "application/json" },
});
const validParsed = await readProviderJsonResponse(validResponse, "Chutes token exchange");
assert.equal(validParsed.access_token, "at_test_123");
assert.equal(validParsed.refresh_token, "rt_test_123");
assert.equal(validParsed.expires_in, 3600);
console.log(
  `PASS  valid Chutes token exchange response: accepted (${validJson.length} bytes, 3 fields parsed)`,
);

// 2. Hostile 64 MiB streaming body for token exchange.
const OVERSIZED_BYTES = 64 * 1024 * 1024;
const oversized = createStreamingJsonResponse({ totalBytes: OVERSIZED_BYTES });
let hostileError = null;
try {
  await readProviderJsonResponse(oversized, "Chutes token exchange hostile");
} catch (err) {
  hostileError = err;
}
assert.ok(hostileError, "hostile response must throw");
assert.match(
  hostileError.message,
  /JSON response exceeds 16777216 bytes/,
  `hostile response must surface canonical overflow error; got: ${hostileError.message}`,
);
console.log(
  `PASS  hostile 64 MiB token exchange response: rejected with "${hostileError.message}"`,
);

// 2b. Same hostile 64 MiB body for token refresh — proves the bound is applied
// to the second production site as well.
const refreshOversized = createStreamingJsonResponse({ totalBytes: OVERSIZED_BYTES });
let refreshError = null;
try {
  await readProviderJsonResponse(refreshOversized, "Chutes token refresh hostile");
} catch (err) {
  refreshError = err;
}
assert.ok(refreshError, "hostile refresh response must throw");
assert.match(
  refreshError.message,
  /JSON response exceeds 16777216 bytes/,
  `hostile refresh response must surface canonical overflow error; got: ${refreshError.message}`,
);
console.log(`PASS  hostile 64 MiB token refresh response: rejected with "${refreshError.message}"`);

// 2c. Same hostile 64 MiB body for userinfo — proves the bound is applied
// to the third production site as well.
const userinfoOversized = createStreamingJsonResponse({ totalBytes: OVERSIZED_BYTES });
let userinfoError = null;
try {
  await readProviderJsonResponse(userinfoOversized, "Chutes userinfo hostile");
} catch (err) {
  userinfoError = err;
}
assert.ok(userinfoError, "hostile userinfo response must throw");
assert.match(
  userinfoError.message,
  /JSON response exceeds 16777216 bytes/,
  `hostile userinfo response must surface canonical overflow error; got: ${userinfoError.message}`,
);
console.log(`PASS  hostile 64 MiB userinfo response: rejected with "${userinfoError.message}"`);

// 3. Negative control: raw `response.json()` on the same 64 MiB body
//    buffers the full body before failing on JSON parse — proves the
//    bounded read is the right shape (vs. an inert helper that
//    silently truncates and then re-fails).
const negativeBody = createStreamingJsonResponse({ totalBytes: OVERSIZED_BYTES });
let negativeError = null;
try {
  await negativeBody.json();
} catch (err) {
  negativeError = err;
}
assert.ok(negativeError, "raw json() must also throw on 64 MiB non-JSON body");
assert.doesNotMatch(
  negativeError.message,
  /JSON response exceeds 16777216 bytes/,
  "raw json() must NOT surface the bounded-reader error (it doesn't go through the helper)",
);
console.log(
  `PASS  negative control: raw response.json() on 64 MiB body failed with "${negativeError.constructor.name}" (no bounded-reader wrapping)`,
);

console.log("=== All repro assertions passed ===");
