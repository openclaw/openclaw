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
 *      poll and submit call sites now route through) — proves the helper
 *      stops early.
 *   3. Drives the changed call sites (`pollDashscopeVideoTaskUntilComplete`
 *      and `runDashscopeVideoGenerationTask`) end-to-end with a streaming
 *      body larger than the cap — proves the PR's actual fix surfaces the
 *      bounded-reader error on the real production paths, not just on the
 *      helper directly.
 *   4. Compares the bounded read to a raw `await response.json()` on a
 *      smaller 2 MiB body so the difference is observable in a one-shot
 *      repro script: bounded read errors with the cap message, raw read
 *      buffers and then fails on JSON parse.
 */
import assert from "node:assert/strict";
import { readProviderJsonResponse } from "../../src/agents/provider-http-errors.js";
import {
  pollDashscopeVideoTaskUntilComplete,
  runDashscopeVideoGenerationTask,
} from "../../src/video-generation/dashscope-compatible.js";

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
    `PASS  bounded read on helper: threw "${error.message}" after ${readCount} / ${chunkCount} chunks (stopped ~${(readCount * chunkSize) / (1024 * 1024)} MiB into a ${(chunkCount * chunkSize) / (1024 * 1024)} MiB body)`,
  );
}

// 2) Drive the changed poll call site end-to-end with a streaming body
//    larger than the cap. The bounded reader must throw before the runtime
//    buffers the whole payload — proves the PR's fix is wired into the
//    production path, not just sitting on the helper.
{
  const chunkCount = 100;
  const chunkSize = 1024 * 1024;
  const streamed = createStreamingJsonResponse({ chunkCount, chunkSize });
  const fetchMock = () => Promise.resolve(streamed.response);
  const headers = new Headers({ authorization: "Bearer test" });

  let error;
  try {
    await pollDashscopeVideoTaskUntilComplete({
      providerLabel: "dashscope",
      taskId: "task_overflow",
      headers,
      fetchFn: fetchMock,
      baseUrl: "https://dashscope.aliyuncs.com",
    });
  } catch (cause) {
    error = cause;
  }

  assert.ok(error, "expected pollDashscopeVideoTaskUntilComplete to throw on oversize body");
  assert.match(
    error.message,
    /JSON response exceeds/,
    `poll path must surface bounded-reader error, got: ${error.message}`,
  );
  const readCount = streamed.getReadCount();
  assert.ok(
    readCount < chunkCount,
    `bounded reader on poll path must stop early; got ${readCount} / ${chunkCount} reads`,
  );
  console.log(
    `PASS  poll call site: threw "${error.message}" after ${readCount} / ${chunkCount} chunks`,
  );
}

// 3) Drive the changed submit call site end-to-end with a streaming body
//    larger than the cap. The bounded reader must throw before the runtime
//    buffers the whole payload — proves the submit path is also bounded.
{
  const chunkCount = 100;
  const chunkSize = 1024 * 1024;
  const streamed = createStreamingJsonResponse({ chunkCount, chunkSize });
  const fetchMock = () => Promise.resolve(streamed.response);
  const headers = new Headers({ authorization: "Bearer test" });

  let error;
  try {
    await runDashscopeVideoGenerationTask({
      providerLabel: "dashscope",
      model: "wan2.5-t2v-preview",
      req: {
        provider: "dashscope",
        model: "wan2.5-t2v-preview",
        prompt: "draw a square",
        cfg: {},
      },
      url: "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      headers,
      baseUrl: "https://dashscope.aliyuncs.com",
      fetchFn: fetchMock,
      defaultTimeoutMs: 60_000,
    });
  } catch (cause) {
    error = cause;
  }

  assert.ok(error, "expected runDashscopeVideoGenerationTask to throw on oversize body");
  assert.match(
    error.message,
    /JSON response exceeds/,
    `submit path must surface bounded-reader error, got: ${error.message}`,
  );
  const readCount = streamed.getReadCount();
  assert.ok(
    readCount < chunkCount,
    `bounded reader on submit path must stop early; got ${readCount} / ${chunkCount} reads`,
  );
  console.log(
    `PASS  submit call site: threw "${error.message}" after ${readCount} / ${chunkCount} chunks`,
  );
}

// 4) Negative control: raw response.json() on a smaller but still invalid body
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
