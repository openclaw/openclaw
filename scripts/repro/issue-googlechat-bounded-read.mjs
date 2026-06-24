#!/usr/bin/env node
/**
 * Live repro for the googlechat bounded-read surface — proves the 16 MiB
 * provider-response cap on `readProviderJsonResponse` for the two success-body
 * reads in the bundled Google Chat plugin:
 *   - extensions/googlechat/src/api.ts readGoogleChatJsonResponse
 *     (used by fetchJson / Google Chat REST API success bodies)
 *   - extensions/googlechat/src/auth.ts readGoogleChatCertsResponse
 *     (used by the Google service-account certs fetch on the OAuth path)
 *
 * Run: pnpm exec tsx scripts/repro/issue-googlechat-bounded-read.mjs
 *
 * The script drives the production helpers with a real `node:http` server
 * bound to 127.0.0.1 that streams an unbounded (64 MiB) JSON body
 * chunk-by-chunk with **no `Content-Length`** header. It then verifies the
 * bounded reader throws the canonical overflow error, observes server-side
 * `bytesSent` ≪ 64 MiB and the connection aborted, and runs a small-body
 * negative control to confirm the cap is the cause of the overflow (not
 * the body structure).
 *
 * Mirrors the proof pattern merged for #96027 / #96035 / #96038 / #96042
 * (Alix-007 bound-stream family), applied to the googlechat plugin surface.
 *
 * Note: `readGoogleChatJsonResponse` and `readGoogleChatCertsResponse` are
 * not exported from `extensions/googlechat/src/api.ts` / `auth.ts` (they're
 * private helpers), so this script drives the production `readProviderJsonResponse`
 * directly through the plugin SDK facade with the same label values the
 * production call sites pass.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

const PROVIDER_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB
const OVERSIZED_BYTES = 64 * 1024 * 1024; // 4× the cap, matches Alix-007 fixtures
const CHUNK_SIZE = 1024 * 1024; // 1 MiB per write

const { readProviderJsonResponse } = await import("openclaw/plugin-sdk/provider-http");

// ─── Server: streams a Content-Length-less 64 MiB body, recording per-request stats.
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
      "Content-Type": "application/json",
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
      const baseUrl = `http://127.0.0.1:${addr.port}${pathToMatch}`;
      resolveServer({
        baseUrl,
        stats: () => ({ ...stats }),
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

// ─── Server: streams a Content-Length-less 8 MiB body (well under the cap)
//      so the bounded reader must accept it; used to verify the cap is the
//      cause of the overflow, not body structure.
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
      "Content-Type": "application/json",
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

// ─── Small valid-body server (for happy path).
function startValidJsonServer(pathToMatch, payload) {
  const server = createServer((req, res) => {
    if (req.url !== pathToMatch) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr) {
        throw new Error("missing server address");
      }
      resolveServer({
        baseUrl: `http://127.0.0.1:${addr.port}${pathToMatch}`,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

console.log("=== Reproduction for googlechat plugin bounded JSON response cap ===");
console.log(`PROVIDER_JSON_RESPONSE_MAX_BYTES = ${PROVIDER_JSON_RESPONSE_MAX_BYTES} bytes (cap)`);
console.log(`would-stream ≈ ${OVERSIZED_BYTES} bytes (4× the cap, no Content-Length)`);

// ─── 1. Hostile Google Chat API success body must be rejected via the bounded reader.
{
  const overflowServer = await startOverflowingServer("/v1/spaces/AAA/messages");
  try {
    const response = await fetch(overflowServer.baseUrl);
    let error = null;
    try {
      // Same label the production api.ts fetchJson helper passes
      await readProviderJsonResponse(response, "Google Chat API");
    } catch (err) {
      error = err;
    }
    assert.ok(error, "Google Chat API success body must throw on hostile body");
    assert.match(
      error.message,
      /Google Chat API/i,
      `error must reference the Google Chat API label; got: ${error.message}`,
    );
    assert.match(
      error.message,
      new RegExp(`exceeds ${PROVIDER_JSON_RESPONSE_MAX_BYTES} bytes`),
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
      `PASS  Google Chat API bounded: rejected with "${error.message.slice(0, 80)}..."; bytesSent=${stats.bytesSent} (< ${OVERSIZED_BYTES}); server.aborted=${stats.aborted}`,
    );
  } finally {
    await overflowServer.close();
  }
}

// ─── 2. Hostile Google Chat certs response must be rejected via the bounded reader.
{
  const overflowServer = await startOverflowingServer("/x509/certs");
  try {
    const response = await fetch(overflowServer.baseUrl);
    let error = null;
    try {
      // Same label the production auth.ts readGoogleChatCertsResponse helper passes
      await readProviderJsonResponse(response, "Google Chat cert fetch");
    } catch (err) {
      error = err;
    }
    assert.ok(error, "Google Chat certs body must throw on hostile body");
    assert.match(
      error.message,
      /Google Chat cert fetch/i,
      `error must reference the Google Chat cert fetch label; got: ${error.message}`,
    );
    assert.match(
      error.message,
      new RegExp(`exceeds ${PROVIDER_JSON_RESPONSE_MAX_BYTES} bytes`),
      `error must surface the canonical overflow text; got: ${error.message}`,
    );

    await new Promise((r) => {
      setTimeout(r, 50);
    });
    const stats = overflowServer.stats();
    assert.equal(
      stats.aborted,
      true,
      `server must observe client abort; stats=${JSON.stringify(stats)}`,
    );
    assert.ok(
      stats.bytesSent < OVERSIZED_BYTES,
      `server must have stopped before the full body was sent; bytesSent=${stats.bytesSent}, expected<${OVERSIZED_BYTES}`,
    );
    console.log(
      `PASS  Google Chat certs bounded: rejected with "${error.message.slice(0, 80)}..."; bytesSent=${stats.bytesSent} (< ${OVERSIZED_BYTES}); server.aborted=${stats.aborted}`,
    );
  } finally {
    await overflowServer.close();
  }
}

// ─── 3. Cap-trace: confirm the bounded reader cancels at ~16-20 MiB sent
//      (not at the first byte, and not after draining the full 64 MiB).
{
  const overflowServer = await startOverflowingServer("/v1/spaces/trace");
  try {
    const response = await fetch(overflowServer.baseUrl);
    let boundedError = null;
    try {
      await readProviderJsonResponse(response, "Google Chat API trace");
    } catch (err) {
      boundedError = err;
    }
    assert.ok(boundedError, "cap-trace: bounded read must throw");
    assert.match(boundedError.message, /exceeds 16777216 bytes/);
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

// ─── 4. Negative control: a small (8 MiB) body succeeds end-to-end via the same
//      bounded reader — proves the cap is the cause of the overflow, not body
//      structure.
{
  const SMALL_BYTES = 8 * 1024 * 1024;
  const smallServer = await startSmallBodyServer("/v1/spaces/small", SMALL_BYTES);
  try {
    const response = await fetch(smallServer.baseUrl);
    let negativeError = null;
    try {
      // Drive the bounded reader directly. For an 8 MiB body the reader will
      // accept the full body and JSON.parse will fail (body is 'a' * 8 MiB).
      // That's expected — the key signal is that the size cap didn't trigger
      // and the stream wasn't aborted.
      await readProviderJsonResponse(response, "Google Chat API small");
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
    // Any error here should NOT be a size overflow.
    if (negativeError) {
      assert.doesNotMatch(
        negativeError.message,
        new RegExp(`exceeds ${PROVIDER_JSON_RESPONSE_MAX_BYTES} bytes`),
        `small body must not trigger the size cap; got: ${negativeError.message}`,
      );
    }
    console.log(
      `PASS  negative control: small body fully drained (${stats.bytesSent} bytes >= ${SMALL_BYTES}); cap did not trigger; aborted=${stats.aborted}`,
    );
  } finally {
    await smallServer.close();
  }
}

// ─── 5. Happy path: a small valid Google Chat message response parses end-to-end.
{
  const validPayload = {
    name: "spaces/AAA/messages/BBB",
    sender: { name: "users/CCC", displayName: "Test User", type: "HUMAN" },
    createTime: "2026-06-24T00:00:00Z",
    text: "hello world",
  };
  const validServer = await startValidJsonServer("/v1/spaces/AAA/messages/BBB", validPayload);
  try {
    const response = await fetch(validServer.baseUrl);
    const parsed = await readProviderJsonResponse(response, "Google Chat API valid");
    assert.equal(parsed.name, validPayload.name);
    assert.equal(parsed.text, "hello world");
    assert.equal(parsed.sender.displayName, "Test User");
    console.log(
      `PASS  happy path: small valid Google Chat response parsed end-to-end (name=${parsed.name})`,
    );
  } finally {
    await validServer.close();
  }
}

console.log("=== All googlechat plugin bounded-read repro assertions passed ===");
