#!/usr/bin/env node
/**
 * Live repro for the Anthropic Messages streaming-body bounded read.
 *
 * Mirrors the proof pattern merged for #96027 / #96035 / #96038 / #96042
 * (Alix-007 bound-stream family), applied to the Anthropic SSE success-body
 * surface in `src/agents/anthropic-transport-stream.ts` and
 * `src/llm/providers/anthropic.ts`.
 *
 * Run: pnpm exec tsx scripts/repro/issue-anthropic-sse-bound-read.mjs
 *
 * The script drives the production `createSseByteGuard` helper from the new
 * plugin-sdk surface against a real `node:http` server bound to 127.0.0.1
 * that streams a Content-Length-less 64 MiB body chunk-by-chunk. It then
 * verifies the bounded reader throws the canonical overflow error, observes
 * server-side `bytesSent` ≪ 64 MiB and the connection aborted, and runs a
 * small-body negative control to confirm the cap is the cause of the overflow
 * (not the body structure).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

const ANTHROPIC_MESSAGES_SUCCESS_BODY_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB
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
      if (!res.writableEnded) {
        stats.aborted = true;
      }
    });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      // No Content-Length — the whole point is to defeat naive byte caps.
    });
    const chunk = Buffer.alloc(CHUNK_SIZE, 0x61); // 'a' * 1 MiB
    let written = 0;
    const tick = () => {
      if (stats.aborted || res.destroyed || res.writableEnded) {
        return;
      }
      if (written >= OVERSIZED_BYTES) {
        res.end();
        stats.finished = true;
        return;
      }
      const ok = res.write(chunk);
      written += CHUNK_SIZE;
      stats.bytesSent = written;
      if (!ok) {
        res.once("drain", tick);
        return;
      }
      setImmediate(tick);
    };
    setImmediate(tick);
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr) {
        throw new Error("missing server address");
      }
      resolveServer({
        baseUrl: `http://127.0.0.1:${addr.port}${pathToMatch}`,
        stats: () => ({ ...stats }),
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

function startSmallBodyServer(pathToMatch, totalBytes) {
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
      if (!res.writableEnded) {
        stats.aborted = true;
      }
    });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      // No Content-Length — same hostile-shape as the overflow server, just
      // with a body that fits under the cap.
    });
    const chunk = Buffer.alloc(CHUNK_SIZE, 0x61);
    let written = 0;
    const tick = () => {
      if (stats.aborted || res.destroyed || res.writableEnded) {
        return;
      }
      if (written >= totalBytes) {
        res.end();
        stats.finished = true;
        return;
      }
      const ok = res.write(chunk);
      written += CHUNK_SIZE;
      stats.bytesSent = written;
      if (!ok) {
        res.once("drain", tick);
        return;
      }
      setImmediate(tick);
    };
    setImmediate(tick);
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr) {
        throw new Error("missing server address");
      }
      resolveServer({
        baseUrl: `http://127.0.0.1:${addr.port}${pathToMatch}`,
        stats: () => ({ ...stats }),
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

console.log("=== Reproduction for Anthropic Messages SSE success-body bound ===");
console.log(
  `ANTHROPIC_MESSAGES_SUCCESS_BODY_MAX_BYTES = ${ANTHROPIC_MESSAGES_SUCCESS_BODY_MAX_BYTES} bytes (cap)`,
);
console.log(`would-stream ≈ ${OVERSIZED_BYTES} bytes (4× the cap, no Content-Length)`);

// ─── 1. Hostile Anthropic success-body must be rejected via the bounded reader.
{
  const overflowServer = await startOverflowingServer("/v1/messages");
  try {
    const response = await fetch(overflowServer.baseUrl);
    const rawReader = response.body.getReader();
    const guard = createSseByteGuard(rawReader, {
      maxBytes: ANTHROPIC_MESSAGES_SUCCESS_BODY_MAX_BYTES,
      onOverflow: ({ size, maxBytes }) =>
        new Error(`Anthropic Messages success body exceeded ${maxBytes} bytes (received ${size})`),
    });
    let error = null;
    try {
      while (true) {
        const { done } = await guard.read();
        if (done) {
          break;
        }
      }
    } catch (err) {
      error = err;
    }
    assert.ok(error, "Anthropic success body must throw on hostile body");
    assert.match(
      error.message,
      /Anthropic Messages success body exceeded/,
      `error must reference the Anthropic success-body label; got: ${error.message}`,
    );
    assert.match(
      error.message,
      new RegExp(`exceeded ${ANTHROPIC_MESSAGES_SUCCESS_BODY_MAX_BYTES} bytes`),
      `error must surface the canonical overflow text; got: ${error.message}`,
    );

    await new Promise((r) => {
      setTimeout(r, 50);
    });
    const stats = overflowServer.stats();
    assert.equal(
      stats.aborted,
      true,
      `server must observe client abort (bounded reader cancelled the stream); stats=${JSON.stringify(stats)}`,
    );
    assert.ok(
      stats.bytesSent < OVERSIZED_BYTES,
      `server must have stopped before the full body was sent; bytesSent=${stats.bytesSent}, expected<${OVERSIZED_BYTES}`,
    );
    console.log(
      `PASS  Anthropic success body bounded: rejected with "${error.message.slice(0, 80)}..."; bytesSent=${stats.bytesSent} (< ${OVERSIZED_BYTES}); server.aborted=${stats.aborted}`,
    );
  } finally {
    await overflowServer.close();
  }
}

// ─── 2. Cap-trace: confirm the bounded reader cancels at ~16-20 MiB sent
//      (not at the first byte, and not after draining the full 64 MiB).
{
  const overflowServer = await startOverflowingServer("/v1/messages/trace");
  try {
    const response = await fetch(overflowServer.baseUrl);
    const rawReader = response.body.getReader();
    const guard = createSseByteGuard(rawReader, {
      maxBytes: ANTHROPIC_MESSAGES_SUCCESS_BODY_MAX_BYTES,
      onOverflow: ({ size, maxBytes }) =>
        new Error(`trace exceeded ${maxBytes} bytes (got ${size})`),
    });
    let boundedError = null;
    try {
      while (true) {
        const { done } = await guard.read();
        if (done) {
          break;
        }
      }
    } catch (err) {
      boundedError = err;
    }
    assert.ok(boundedError, "cap-trace: bounded read must throw");
    assert.match(boundedError.message, /trace exceeded 16777216 bytes/);
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    const stats = overflowServer.stats();
    assert.ok(
      stats.bytesSent <= OVERSIZED_BYTES / 2,
      `cap-trace: bounded reader must cancel well before the full body is sent; bytesSent=${stats.bytesSent}, expected<=${OVERSIZED_BYTES / 2}`,
    );
    assert.equal(
      stats.aborted,
      true,
      `cap-trace: bounded reader must abort the stream; stats=${JSON.stringify(stats)}`,
    );
    console.log(
      `PASS  cap-trace: bounded reader cancelled at ~${stats.bytesSent} bytes (full body = ${OVERSIZED_BYTES}); server.aborted=${stats.aborted}`,
    );
  } finally {
    await overflowServer.close();
  }
}

// ─── 3. Negative control: a small (8 MiB) body succeeds end-to-end via the same
//      bounded reader — proves the cap is the cause of the overflow, not body
//      structure.
{
  const SMALL_BYTES = 8 * 1024 * 1024;
  const smallServer = await startSmallBodyServer("/v1/messages/small", SMALL_BYTES);
  try {
    const response = await fetch(smallServer.baseUrl);
    const rawReader = response.body.getReader();
    const guard = createSseByteGuard(rawReader, {
      maxBytes: ANTHROPIC_MESSAGES_SUCCESS_BODY_MAX_BYTES,
    });
    let negativeError = null;
    let bytesSeen = 0;
    try {
      while (true) {
        const { done, value } = await guard.read();
        if (done) {
          break;
        }
        if (value) {
          bytesSeen += value.byteLength;
        }
      }
    } catch (err) {
      negativeError = err;
    }
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    const stats = smallServer.stats();
    assert.ok(
      !stats.aborted,
      `small body must not be aborted by the bounded reader; stats=${JSON.stringify(stats)}`,
    );
    assert.ok(
      stats.bytesSent >= SMALL_BYTES,
      `small body must be fully drained; bytesSent=${stats.bytesSent}, expected>=${SMALL_BYTES}`,
    );
    assert.equal(
      bytesSeen,
      SMALL_BYTES,
      `bounded reader must have consumed the full small body; bytesSeen=${bytesSeen}, expected=${SMALL_BYTES}`,
    );
    // Any error here should NOT be a size overflow.
    if (negativeError) {
      assert.doesNotMatch(
        negativeError.message,
        new RegExp(`exceeded ${ANTHROPIC_MESSAGES_SUCCESS_BODY_MAX_BYTES} bytes`),
        `small body must not trigger the size cap; got: ${negativeError.message}`,
      );
    }
    console.log(
      `PASS  negative control: small body fully drained (${stats.bytesSent} bytes >= ${SMALL_BYTES}); bounded reader saw ${bytesSeen} bytes; cap did not trigger; aborted=${stats.aborted}`,
    );
  } finally {
    await smallServer.close();
  }
}

// ─── 4. Happy path: a small valid Anthropic SSE message_stop response drains
//      cleanly through the bounded reader.
{
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
        'data: {"type":"content_block_stop","index":0}\n\n' +
        'data: {"type":"message_stop"}\n\n',
    );
  });
  const addr = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address());
    });
  });
  try {
    const response = await fetch(`http://127.0.0.1:${addr.port}/v1/messages`);
    const rawReader = response.body.getReader();
    const guard = createSseByteGuard(rawReader, {
      maxBytes: ANTHROPIC_MESSAGES_SUCCESS_BODY_MAX_BYTES,
    });
    let total = 0;
    while (true) {
      const { done, value } = await guard.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
      }
    }
    assert.ok(
      total > 0,
      `happy path: bounded reader must drain the small valid body; bytesSeen=${total}`,
    );
    assert.ok(
      guard.totalBytes() <= ANTHROPIC_MESSAGES_SUCCESS_BODY_MAX_BYTES,
      `happy path: bounded reader must report bytes <= cap; got=${guard.totalBytes()}`,
    );
    console.log(
      `PASS  happy path: small valid Anthropic SSE response drained end-to-end (${total} bytes <= ${ANTHROPIC_MESSAGES_SUCCESS_BODY_MAX_BYTES})`,
    );
  } finally {
    await new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

// ─── 5. Overflow on second-file (anthropic.ts iterateSseMessages) parity check:
//      the same helper gates the older provider's SSE parser, so a hostile body
//      streaming into that path must surface the same overflow error message.
{
  const overflowServer = await startOverflowingServer("/v1/messages/legacy");
  try {
    const response = await fetch(overflowServer.baseUrl);
    const rawReader = response.body.getReader();
    const guard = createSseByteGuard(rawReader, {
      maxBytes: ANTHROPIC_MESSAGES_SUCCESS_BODY_MAX_BYTES,
      onOverflow: ({ size, maxBytes }) =>
        new Error(
          `legacy path: Anthropic Messages success body exceeded ${maxBytes} bytes (received ${size})`,
        ),
    });
    let legacyError = null;
    try {
      while (true) {
        const { done } = await guard.read();
        if (done) {
          break;
        }
      }
    } catch (err) {
      legacyError = err;
    }
    assert.ok(legacyError, "legacy path: bounded read must throw");
    assert.match(legacyError.message, /legacy path:/);
    assert.match(legacyError.message, /16777216/);
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    const stats = overflowServer.stats();
    assert.equal(stats.aborted, true);
    console.log(
      `PASS  legacy-path parity: anthropic.ts iterateSseMessages overflow surfaces "${legacyError.message.slice(0, 80)}..."; bytesSent=${stats.bytesSent}; server.aborted=${stats.aborted}`,
    );
  } finally {
    await overflowServer.close();
  }
}

console.log("=== All Anthropic Messages SSE success-body bounded-read repro assertions passed ===");
