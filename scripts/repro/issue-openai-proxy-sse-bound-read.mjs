#!/usr/bin/env node
/**
 * Live repro for the OpenAI Codex Responses + runtime proxy streaming-body
 * bounded read.
 *
 * Mirrors the proof pattern from PR #96632 (Anthropic SSE success-body bound)
 * and Alix-007's bound-stream family, applied to:
 *   - src/llm/providers/openai-chatgpt-responses.ts (parseSSE)
 *   - src/agents/runtime/proxy.ts (streamProxy)
 *
 * Run: pnpm exec tsx scripts/repro/issue-openai-proxy-sse-bound-read.mjs
 *
 * The script drives the production `createSseByteGuard` helper from
 * src/agents/streaming-byte-guard.ts against a real `node:http` server bound
 * to 127.0.0.1 that streams a Content-Length-less 64 MiB body chunk-by-chunk.
 * It then verifies the bounded reader throws the canonical overflow error,
 * observes server-side `bytesSent` ≪ 64 MiB and the connection aborted, and
 * runs a small-body negative control to confirm the cap is the cause of the
 * overflow (not the body structure).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

const OPENAI_PROXY_SUCCESS_BODY_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB
const OVERSIZED_BYTES = 64 * 1024 * 1024; // 4× the cap, matches Alix-007 fixtures
const CHUNK_SIZE = 1024 * 1024; // 1 MiB per write

const { createSseByteGuard } = await import("../../src/agents/streaming-byte-guard.ts");

function startOverflowingServer(pathToMatch) {
  const stats = {
    path: "",
    bytesSent: 0,
    aborted: false,
    finished: false,
  };
  const server = createServer((req, res) => {
    stats.path = req.url ?? "";
    req.once("aborted", () => {
      stats.aborted = true;
    });
    res.once("close", () => {
      stats.finished = !res.writableEnded;
    });

    if (req.url !== pathToMatch) {
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      // Note: deliberately no Content-Length, to mirror a chunked transfer
      // encoding where the body length is unknown up-front.
      "transfer-encoding": "chunked",
    });

    let written = 0;
    const writeChunk = () => {
      if (stats.aborted || !res.writable) {
        return;
      }
      const remaining = OVERSIZED_BYTES - written;
      if (remaining <= 0) {
        res.end();
        return;
      }
      const size = Math.min(CHUNK_SIZE, remaining);
      const ok = res.write(Buffer.alloc(size, 0x41));
      stats.bytesSent += size;
      written += size;
      if (ok) {
        setImmediate(writeChunk);
      } else {
        res.once("drain", writeChunk);
      }
    };
    writeChunk();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, stats });
    });
  });
}

function startSmallServer(pathToMatch, payload) {
  const stats = {
    path: "",
    bytesSent: 0,
    aborted: false,
  };
  const server = createServer((req, res) => {
    stats.path = req.url ?? "";
    req.once("aborted", () => {
      stats.aborted = true;
    });
    if (req.url !== pathToMatch) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    stats.bytesSent = payload.length;
    res.end(payload);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, stats });
    });
  });
}

function startHappySseServer(pathToMatch) {
  const happyFrame = `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`;
  const doneFrame = `data: ${JSON.stringify({ type: "done", reason: "stop", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })}\n\n`;
  return startSmallServer(pathToMatch, happyFrame + doneFrame);
}

async function driveBoundedReader(port, pathToMatch) {
  const response = await fetch(`http://127.0.0.1:${port}${pathToMatch}`);
  if (!response.body) {
    throw new Error("expected response body");
  }
  const reader = response.body.getReader();
  const guard = createSseByteGuard(reader, {
    maxBytes: OPENAI_PROXY_SUCCESS_BODY_MAX_BYTES,
    onOverflow: ({ size, maxBytes }) =>
      new Error(
        `OpenAI Codex Responses success body exceeded ${maxBytes} bytes (received ${size})`,
      ),
  });
  let caught = null;
  try {
    while (true) {
      const { done } = await guard.read();
      if (done) {
        break;
      }
    }
  } catch (err) {
    caught = err;
  }
  // Only release the lock; do NOT call guard.cancel() because that would
  // flip overflowed()=true even on a fully-drained body. Overflow already
  // cancelled the underlying reader when it triggered.
  try {
    reader.releaseLock();
  } catch {}
  return { caught, totalBytes: guard.totalBytes(), overflowed: guard.overflowed() };
}

async function close(server) {
  await new Promise((resolve) => {
    server.close(resolve);
  });
}

async function main() {
  console.log(
    "=== Reproduction for OpenAI Codex Responses + runtime proxy SSE success-body bound ===",
  );
  console.log(
    `OPENAI_PROXY_SUCCESS_BODY_MAX_BYTES = ${OPENAI_PROXY_SUCCESS_BODY_MAX_BYTES} bytes (cap)`,
  );
  console.log(`would-stream ≈ ${OVERSIZED_BYTES} bytes (4× the cap, no Content-Length)\n`);

  // -------- Case 1: Anthropic-style streaming 200 body bounded (openai path) --------
  {
    const { server, port, stats } = await startOverflowingServer("/api/stream");
    try {
      const { caught, totalBytes, overflowed } = await driveBoundedReader(port, "/api/stream");
      assert.ok(caught instanceof Error, "expected overflow error");
      assert.match(caught.message, /OpenAI Codex Responses success body exceeded 16777216 bytes/);
      assert.ok(overflowed, "guard should report overflowed=true");
      // totalBytes reports bytes successfully read BEFORE overflow (≤ cap).
      // The helper rejects when next would exceed the cap, so total stays at
      // the last successful read — but bounded, never approaching OVERSIZED_BYTES.
      assert.ok(
        totalBytes <= OPENAI_PROXY_SUCCESS_BODY_MAX_BYTES,
        `totalBytes (${totalBytes}) should be ≤ cap (${OPENAI_PROXY_SUCCESS_BODY_MAX_BYTES})`,
      );
      assert.ok(totalBytes < OVERSIZED_BYTES, `totalBytes (${totalBytes}) should be << full body`);
      assert.ok(
        stats.bytesSent < OVERSIZED_BYTES,
        `server.bytesSent (${stats.bytesSent}) should be < ${OVERSIZED_BYTES}`,
      );
      // Give the server a beat to observe the client-side abort.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      assert.equal(stats.aborted, true, "server should observe aborted=true after cancel");
      console.log(
        `PASS  OpenAI Codex Responses success body bounded: rejected with "${caught.message.slice(0, 96)}..."; ` +
          `bytesSent=${stats.bytesSent} (< ${OVERSIZED_BYTES}); server.aborted=${stats.aborted}`,
      );
    } finally {
      await close(server);
    }
  }

  // -------- Case 2: cap-trace — show the bounded reader cancelled, not the full body --------
  {
    const { server, port, stats } = await startOverflowingServer("/api/stream");
    try {
      const { totalBytes } = await driveBoundedReader(port, "/api/stream");
      // Wait briefly so any pending server write completes (it shouldn't,
      // because the cancel propagated via response.body cancel).
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      assert.ok(
        totalBytes < OVERSIZED_BYTES,
        `bounded reader should have cancelled at ${totalBytes} bytes (< ${OVERSIZED_BYTES})`,
      );
      assert.ok(
        stats.bytesSent < OVERSIZED_BYTES,
        `server.bytesSent (${stats.bytesSent}) should be < ${OVERSIZED_BYTES} after cancel`,
      );
      console.log(
        `PASS  cap-trace: bounded reader cancelled at ~${totalBytes} bytes (full body = ${OVERSIZED_BYTES}); ` +
          `server.aborted=${stats.aborted}`,
      );
    } finally {
      await close(server);
    }
  }

  // -------- Case 3: negative control — small body fully drained, no cap --------
  {
    const small = "x".repeat(8 * 1024 * 1024);
    const { server, port, stats } = await startSmallServer("/api/stream", small);
    try {
      const { caught, totalBytes, overflowed } = await driveBoundedReader(port, "/api/stream");
      assert.equal(caught, null, "small body must not trigger overflow");
      assert.equal(overflowed, false, "guard should report overflowed=false");
      assert.ok(
        totalBytes >= small.length,
        `totalBytes (${totalBytes}) should fully drain small body`,
      );
      assert.equal(stats.aborted, false, "server should not observe aborted for small body");
      console.log(
        `PASS  negative control: small body fully drained (${totalBytes} bytes >= ${small.length}); ` +
          `bounded reader saw ${totalBytes} bytes; cap did not trigger; aborted=${stats.aborted}`,
      );
    } finally {
      await close(server);
    }
  }

  // -------- Case 4: happy path — small valid OpenAI Codex Responses SSE response --------
  {
    const { server, port } = await startHappySseServer("/api/stream");
    try {
      const { caught, totalBytes, overflowed } = await driveBoundedReader(port, "/api/stream");
      assert.equal(caught, null, "happy path must not throw");
      assert.equal(overflowed, false, "happy path must not report overflowed");
      assert.ok(totalBytes > 0 && totalBytes < OPENAI_PROXY_SUCCESS_BODY_MAX_BYTES);
      console.log(
        `PASS  happy path: small valid OpenAI Codex Responses SSE response drained end-to-end ` +
          `(${totalBytes} bytes <= ${OPENAI_PROXY_SUCCESS_BODY_MAX_BYTES})`,
      );
    } finally {
      await close(server);
    }
  }

  // -------- Case 5: legacy-path parity — drive openai-chatgpt-responses.parseSSE against the
  //                same hostile server to prove the production call site rejects the same way.
  {
    const { server, port, stats } = await startOverflowingServer("/api/stream");
    try {
      const { parseSSEForTest } =
        await import("../../src/llm/providers/openai-chatgpt-responses.ts");
      const response = await fetch(`http://127.0.0.1:${port}/api/stream`);
      if (!response.body) {
        throw new Error("expected response body");
      }
      let caught = null;
      try {
        for await (const event of parseSSEForTest(response)) {
          expect(event).toBeDefined();
        }
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof Error, "parseSSE should propagate overflow error");
      assert.match(caught.message, /OpenAI Codex Responses success body exceeded 16777216 bytes/);
      assert.ok(
        stats.bytesSent < OVERSIZED_BYTES,
        `server.bytesSent (${stats.bytesSent}) should be < ${OVERSIZED_BYTES}`,
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      assert.equal(stats.aborted, true);
      console.log(
        `PASS  parseSSEForTest overflow surfaces "${caught.message.slice(0, 96)}..."; ` +
          `bytesSent=${stats.bytesSent}; server.aborted=${stats.aborted}`,
      );
    } finally {
      await close(server);
    }
  }

  console.log(
    "=== All OpenAI Codex Responses + runtime proxy SSE success-body bounded-read repro assertions passed ===",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
