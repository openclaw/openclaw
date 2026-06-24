#!/usr/bin/env node
/**
 * Live repro for PR #96144 — proves the canonical 16 MiB provider-response
 * cap on `readProviderJsonResponse` (a) accepts a valid OpenAI video
 * submit response under the cap and (b) rejects a hostile oversized
 * response before OOM.
 *
 * Run: pnpm exec tsx scripts/repro/issue-96144-openai-video-cap.mjs
 *
 * The script drives the production `readProviderJsonResponse` directly
 * (no vitest mock) with two streaming bodies:
 *   1. Valid: a realistic Sora submit response shape (id/model/status/
 *      prompt/seconds/size) under the 16 MiB cap → accepted, parsed
 *      payload returned.
 *   2. Hostile: a 64 MiB streaming body → rejected with the canonical
 *      "JSON response exceeds 16777216 bytes" error before the runtime
 *      buffers the full body.
 *
 * A negative control shows the legacy raw `response.json()` on the
 * same 64 MiB body buffers the full body and only fails on JSON parse,
 * proving the bounded read is the right shape.
 *
 * This is the same helper that `extensions/openai/video-generation-provider.ts:427`
 * now routes the Sora submit response through after the PR — the helper
 * is provider-agnostic, so the canonical 16 MiB cap applies to OpenAI
 * video the same way it does to OpenAI-compatible image / DashScope
 * video / provider-http-errors paths.
 */
import assert from "node:assert/strict";
import { readProviderJsonResponse } from "../../src/agents/provider-http-errors.ts";

const PROVIDER_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB
const OPENAI_VIDEO_LABEL = "OpenAI video generation";

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

console.log("=== Reproduction for PR #96144 — OpenAI video submit response cap policy ===");
console.log(`PROVIDER_JSON_RESPONSE_MAX_BYTES = ${PROVIDER_JSON_RESPONSE_MAX_BYTES} bytes`);
console.log(`bounded-reader label = "${OPENAI_VIDEO_LABEL}"`);

// 1. Valid OpenAI video submit response under the cap.
//    Shape mirrors `OpenAIVideoResponse` (extensions/openai/video-generation-provider.ts:53):
//      { id, model, status, prompt, seconds, size, error }
//    A 4 MiB prompt payload is well below the 16 MiB cap and represents
//    a realistic long-prompt Sora submit envelope.
const VALID_PAYLOAD_BYTES = 4 * 1024 * 1024;
const validBody = {
  id: "video_abc123",
  model: "sora-1.0",
  status: "queued",
  prompt: "p".repeat(VALID_PAYLOAD_BYTES),
  seconds: "8",
  size: "1280x720",
  error: null,
};
const validJson = JSON.stringify(validBody);
console.log(
  `Valid envelope: ${validJson.length} bytes (${(validJson.length / 1024 / 1024).toFixed(2)} MiB) ` +
    `id=${validBody.id} status=${validBody.status}`,
);
assert.ok(
  validJson.length < PROVIDER_JSON_RESPONSE_MAX_BYTES,
  `valid envelope must fit under 16 MiB; got ${validJson.length} bytes`,
);
const validResponse = new Response(validJson, {
  status: 200,
  headers: { "content-type": "application/json" },
});
const validParsed = await readProviderJsonResponse(validResponse, OPENAI_VIDEO_LABEL);
assert.equal(validParsed.id, "video_abc123", "valid submit response must be accepted; id missing");
assert.equal(validParsed.model, "sora-1.0", "valid submit response must preserve model field");
assert.equal(validParsed.status, "queued", "valid submit response must preserve status field");
assert.equal(
  validParsed.prompt.length,
  VALID_PAYLOAD_BYTES,
  "valid submit response must preserve full prompt payload",
);
console.log(`PASS  valid OpenAI video submit response: accepted, id=${validParsed.id}`);

// 2. Hostile oversized response: 64 MiB streaming body.
const OVERSIZED_BYTES = 64 * 1024 * 1024;
const oversized = createStreamingJsonResponse({
  totalBytes: OVERSIZED_BYTES,
  chunkSize: 1024 * 1024,
});
let hostileError = null;
try {
  await readProviderJsonResponse(oversized, OPENAI_VIDEO_LABEL);
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
//    silently truncates and then re-fails). This is the exact code path
//    the PR replaces in `extensions/openai/video-generation-provider.ts:427`.
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
