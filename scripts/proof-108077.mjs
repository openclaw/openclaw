// Local real-behavior proof for PR #108077.
// Starts a real HTTP server and exercises the production Nostr profile ops
// through actual Node fetch calls (with only a relative-to-absolute URL shim).
// Scenarios:
//   1. Normal publish/import receive valid JSON responses quickly.
//   2. Stalled gateway requests accept headers but never send a body; the
//      client AbortController fires after the 30 s deadline and the promise
//      rejects with a TimeoutError DOMException.

import { createServer } from "node:http";
import { performance } from "node:perf_hooks";

const DEADLINE_MS = 30_000;
const NORMAL_TIMEOUT_MS = 5_000;

function log(message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`);
}

async function startServer() {
  const pendingSockets = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost/`);
    const isStall = url.searchParams.has("stall");
    const accountId = url.pathname.split("/")[4] ?? "unknown";

    log(`server: ${req.method} ${url.pathname}${url.search} (accountId=${accountId})`);

    if (isStall) {
      // Accept headers and keep the socket open forever to simulate a stalled
      // gateway that never produces a response body.
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders?.();
      log("server: stalled response headers sent, holding socket open");
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method === "PUT" && url.pathname.endsWith("/profile")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, persisted: true }));
      } else if (req.method === "POST" && url.pathname.endsWith("/import")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            imported: { name: "Imported Profile", about: "from gateway" },
            saved: true,
          }),
        );
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });

  server.on("connection", (socket) => {
    pendingSockets.add(socket);
    socket.on("close", () => pendingSockets.delete(socket));
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  function destroyStallSockets() {
    for (const socket of pendingSockets) {
      socket.destroy();
    }
    pendingSockets.clear();
  }

  return { server, port, destroyStallSockets };
}

async function main() {
  log("starting local HTTP server");
  const { server, port, destroyStallSockets } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`server listening at ${baseUrl}`);

  // Minimal shim: the production helpers build relative URLs because they run
  // inside the Control UI against the page origin. In Node we resolve those
  // relative URLs against our local test server. Everything else (headers,
  // body serialization, AbortSignal wiring) uses the real fetch.
  //
  // The header `x-local-stall` is a proof-only signal: the wrapper translates
  // it into the `?stall` query parameter and removes it from the request so the
  // server hangs without receiving an unexpected header.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function fetchWithBase(input, init) {
    const headers = init?.headers ? new Headers(init.headers) : new Headers();
    const shouldStall = headers.get("x-local-stall") === "true";
    if (shouldStall) {
      headers.delete("x-local-stall");
    }

    let resolved;
    if (typeof input === "string" && input.startsWith("/")) {
      resolved = `${baseUrl}${input}${shouldStall ? "?stall" : ""}`;
    } else if (input instanceof Request && input.url.startsWith("/")) {
      resolved = new Request(`${baseUrl}${input.url}${shouldStall ? "?stall" : ""}`, input);
    } else {
      resolved = input;
    }

    return originalFetch(resolved, { ...init, headers });
  };

  let exitCode = 0;

  try {
    const { putNostrProfile, importNostrProfile } =
      await import("../ui/src/pages/channels/nostr-profile-ops.ts");

    const profile = {
      name: "Live Proof Profile",
      about: "Demonstrates normal publish/import over real HTTP",
      picture: "https://example.com/redacted.png",
      nip05: "proof@example.com",
    };

    // --- Normal success paths ------------------------------------------------
    log("=== normal publish (PUT /profile) ===");
    const publishStart = performance.now();
    const publishResult = await Promise.race([
      putNostrProfile({
        accountId: "proof-account",
        headers: { "x-proof": "108077" },
        values: profile,
      }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("normal publish did not complete promptly")),
          NORMAL_TIMEOUT_MS,
        );
      }),
    ]);
    const publishMs = (performance.now() - publishStart).toFixed(1);
    log(`normal publish completed in ${publishMs} ms`);
    log(`normal publish response status: ${publishResult.response.status}`);
    log(`normal publish data: ${JSON.stringify(publishResult.data)}`);

    log("=== normal import (POST /profile/import) ===");
    const importStart = performance.now();
    const importResult = await Promise.race([
      importNostrProfile({
        accountId: "proof-account",
        headers: { "x-proof": "108077" },
      }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("normal import did not complete promptly")),
          NORMAL_TIMEOUT_MS,
        );
      }),
    ]);
    const importMs = (performance.now() - importStart).toFixed(1);
    log(`normal import completed in ${importMs} ms`);
    log(`normal import response status: ${importResult.response.status}`);
    log(`normal import data: ${JSON.stringify(importResult.data)}`);

    // --- Stalled gateway timeout paths ---------------------------------------
    log("=== stalled publish timeout (PUT /profile?stall) ===");
    const stalledPublishStart = performance.now();
    let stalledPublishError;
    try {
      await putNostrProfile({
        accountId: "proof-account",
        headers: { "x-proof": "108077", "x-local-stall": "true" },
        values: profile,
      });
      throw new Error("stalled publish unexpectedly resolved");
    } catch (error) {
      stalledPublishError = error;
    }
    const stalledPublishMs = performance.now() - stalledPublishStart;
    log(
      `stalled publish rejected after ${stalledPublishMs.toFixed(1)} ms ` +
        `(expected ~${DEADLINE_MS} ms)`,
    );
    log(
      `stalled publish error: name=${stalledPublishError?.name ?? "unknown"} ` +
        `message=${stalledPublishError?.message ?? "(none)"}`,
    );
    if (stalledPublishError?.name !== "TimeoutError" || stalledPublishMs < DEADLINE_MS * 0.9) {
      log("FAIL: stalled publish did not reject with a TimeoutError near the deadline");
      exitCode = 1;
    }

    log("=== stalled import timeout (POST /profile/import?stall) ===");
    const stalledImportStart = performance.now();
    let stalledImportError;
    try {
      await importNostrProfile({
        accountId: "proof-account",
        headers: { "x-proof": "108077", "x-local-stall": "true" },
      });
      throw new Error("stalled import unexpectedly resolved");
    } catch (error) {
      stalledImportError = error;
    }
    const stalledImportMs = performance.now() - stalledImportStart;
    log(
      `stalled import rejected after ${stalledImportMs.toFixed(1)} ms ` +
        `(expected ~${DEADLINE_MS} ms)`,
    );
    log(
      `stalled import error: name=${stalledImportError?.name ?? "unknown"} ` +
        `message=${stalledImportError?.message ?? "(none)"}`,
    );
    if (stalledImportError?.name !== "TimeoutError" || stalledImportMs < DEADLINE_MS * 0.9) {
      log("FAIL: stalled import did not reject with a TimeoutError near the deadline");
      exitCode = 1;
    }

    if (exitCode === 0) {
      log("PASS: all real-behavior proof scenarios completed");
    }
  } catch (error) {
    log(`UNEXPECTED ERROR: ${error?.stack ?? error}`);
    exitCode = 1;
  } finally {
    destroyStallSockets();
    server.closeAllConnections?.();
    await new Promise((resolve) => {
      server.close(resolve);
    });
    log("server stopped");
  }

  process.exit(exitCode);
}

main();
