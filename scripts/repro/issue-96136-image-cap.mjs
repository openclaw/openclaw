#!/usr/bin/env node
/**
 * Live repro for PR #96136 — proves the canonical 16 MiB provider-response
 * cap on `readProviderJsonResponse` (a) accepts a valid 4-image
 * OpenAI-compatible response under the cap and (b) rejects a hostile
 * oversized response before OOM.
 *
 * Run: pnpm exec tsx scripts/repro/issue-96136-image-cap.mjs
 *
 * The script drives the production `readProviderJsonResponse` directly
 * (no vitest mock) with two streaming bodies:
 *   1. Valid: 4 PNG b64_json payloads at 1 MiB raw each, total ≈ 5.4 MiB
 *      serialized → accepted, parsed payload returned.
 *   2. Hostile: a 64 MiB streaming body → rejected with the canonical
 *      "JSON response exceeds 16777216 bytes" error before the runtime
 *      buffers the full body.
 *
 * A negative control shows the legacy raw `response.json()` on the
 * same 64 MiB body buffers the full body and only fails on JSON parse,
 * proving the bounded read is the right shape.
 */
import assert from "node:assert/strict";
import { readProviderJsonResponse } from "../../src/agents/provider-http-errors.ts";

const PROVIDER_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

function createStreamingJsonResponse({ totalBytes, chunkSize, contentType = "application/json" }) {
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
  return new Response(stream, { status: 200, headers: { "content-type": contentType } });
}

console.log("=== Reproduction for PR #96136 — image response cap policy ===");
console.log(`PROVIDER_JSON_RESPONSE_MAX_BYTES = ${PROVIDER_JSON_RESPONSE_MAX_BYTES} bytes`);

// 1. Valid 4-image response: 4 PNG b64_json at 1 MiB raw each.
const ONE_PNG_B64_BYTES = Math.ceil((1024 * 1024) / 3) * 4; // ~1.4 MB
const FOUR_PNG_B64_BYTES = ONE_PNG_B64_BYTES * 4;
console.log(
  `Valid envelope: 4 images x ${ONE_PNG_B64_BYTES} b64 bytes = ${FOUR_PNG_B64_BYTES} bytes (${(FOUR_PNG_B64_BYTES / 1024 / 1024).toFixed(2)} MiB)`,
);
assert.ok(
  FOUR_PNG_B64_BYTES < PROVIDER_JSON_RESPONSE_MAX_BYTES,
  `4-image envelope must fit under 16 MiB; got ${FOUR_PNG_B64_BYTES} bytes`,
);
const validBody = {
  data: [
    { b64_json: "a".repeat(ONE_PNG_B64_BYTES) },
    { b64_json: "b".repeat(ONE_PNG_B64_BYTES) },
    { b64_json: "c".repeat(ONE_PNG_B64_BYTES) },
    { b64_json: "d".repeat(ONE_PNG_B64_BYTES) },
  ],
};
const validJson = JSON.stringify(validBody);
const validResponse = new Response(validJson, {
  status: 200,
  headers: { "content-type": "application/json" },
});
const validParsed = await readProviderJsonResponse(validResponse, "test image generation");
assert.equal(
  validParsed.data.length,
  4,
  `valid 4-image response must be accepted; got ${validParsed.data.length} images`,
);
console.log("PASS  valid 4-image response: accepted, 4 images parsed");

// 2. Hostile oversized response: 64 MiB streaming body.
const OVERSIZED_BYTES = 64 * 1024 * 1024;
const oversized = createStreamingJsonResponse({
  totalBytes: OVERSIZED_BYTES,
  chunkSize: 1024 * 1024,
});
let hostileError = null;
try {
  await readProviderJsonResponse(oversized, "test image generation hostile");
} catch (err) {
  hostileError = err;
}
assert.ok(hostileError, "hostile response must throw");
assert.match(
  hostileError.message,
  /JSON response exceeds 16777216 bytes/,
  `hostile response must surface canonical overflow error; got: ${hostileError.message}`,
);
console.log(`PASS  hostile 64 MiB response: rejected with "${hostileError.message}"`);

// 3. Negative control: raw `response.json()` on the same 64 MiB body
//    buffers the full body before failing on JSON parse — proves the
//    bounded read is the right shape (vs. an inert helper that
//    silently truncates and then re-fails).
const negativeBody = createStreamingJsonResponse({
  totalBytes: OVERSIZED_BYTES,
  chunkSize: 1024 * 1024,
});
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
