#!/usr/bin/env node
/**
 * Live repro for the dashscope-compatible bounded JSON read fix.
 *
 * Run: pnpm exec tsx scripts/repro/issue-dashscope-response-cap.mjs
 *
 * Behavior proved here (real-environment proof, not a unit-test mock):
 *   1. Constructs a 32 MiB streaming Response that grows past the canonical
 *      provider JSON response cap (16 MiB).
 *   2. Drives the production `readProviderJsonResponse` helper from
 *      `src/agents/provider-http-errors.ts` (the same helper the dashscope
 *      poll and submit call sites now route through).
 *   3. Asserts the helper throws a `JSON response exceeds` error and that
 *      the response body is cancelled before all 32 chunks are pulled —
 *      proving we do not buffer the entire payload before failing.
 *   4. Compares the bounded read to a raw `await response.json()` on a
 *      smaller 2 MiB body so the difference is observable in a one-shot
 *      repro script: bounded read errors with the cap message, raw read
 *      buffers and then fails on JSON parse.
 */
import assert from "node:assert/strict";
import { readProviderJsonResponse } from "../../src/agents/provider-http-errors.js";

const PROVIDER_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

console.log("=== Reproduction for dashscope-compatible bounded JSON read ===");
console.log(`PROVIDER_JSON_RESPONSE_MAX_BYTES = ${PROVIDER_JSON_RESPONSE_MAX_BYTES} bytes`);
console.log();

function createStreamingJsonResponse({ chunkCount, chunkSize }) {
  let reads = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    pull(controller) {
      if (reads >= chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(encoder.encode("a".repeat(chunkSize)));
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    getReadCount: () => reads,
  };
}

// 1) Bounded read on a body that exceeds the canonical cap.
{
  const chunkCount = 32;
  const chunkSize = 1024 * 1024; // 1 MiB per chunk → 32 MiB total
  const streamed = createStreamingJsonResponse({ chunkCount, chunkSize });

  let error;
  try {
    await readProviderJsonResponse(streamed.response, "dashscope video-generation task poll");
  } catch (cause) {
    error = cause;
  }

  assert.ok(error, "expected readProviderJsonResponse to throw on oversize body");
  assert.match(
    error.message,
    /JSON response exceeds/,
    `expected cap-exceeded error, got: ${error.message}`,
  );
  const readCount = streamed.getReadCount();
  assert.ok(
    readCount < chunkCount,
    `bounded reader must stop early; got ${readCount} / ${chunkCount} reads`,
  );
  console.log(
    `PASS  bounded read: threw "${error.message}" after ${readCount} / ${chunkCount} chunks (stopped ~${(readCount * chunkSize) / (1024 * 1024)} MiB into a ${(chunkCount * chunkSize) / (1024 * 1024)} MiB body)`,
  );
}

// 2) Negative control: raw response.json() on a smaller but still invalid body
//    buffers the whole payload before failing on JSON parse — proves the
//    bounded read is the right shape.
{
  const chunkCount = 2;
  const chunkSize = 1024 * 1024; // 2 MiB total
  const streamed = createStreamingJsonResponse({ chunkCount, chunkSize });

  let error;
  try {
    await streamed.response.json();
  } catch (cause) {
    error = cause;
  }

  assert.ok(error, "expected raw response.json() to throw on malformed body");
  assert.match(
    error.message,
    /not valid JSON|Unexpected token/,
    `expected JSON parse error from buffered read, got: ${error.message}`,
  );
  const readCount = streamed.getReadCount();
  assert.equal(
    readCount,
    chunkCount,
    `raw response.json() must buffer the whole body; got ${readCount} / ${chunkCount} reads`,
  );
  console.log(
    `PASS  negative control: raw response.json() buffered all ${readCount} / ${chunkCount} chunks (${(readCount * chunkSize) / (1024 * 1024)} MiB) and failed only on JSON parse — proves bounded read is the right shape`,
  );
}

console.log();
console.log("=== All repro assertions passed ===");
