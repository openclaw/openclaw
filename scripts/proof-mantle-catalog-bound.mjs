import { once } from "node:events";
/**
 * Affected-path proof: discoverMantleModels against oversized streamed catalog JSON.
 *
 * Drives the real Mantle discovery entry point (not just readResponseWithLimit) with an
 * injected fetchFn pointed at a local node:http server streaming ~24 MiB without
 * Content-Length, then asserts fail-soft fallback and early stream cancellation.
 *
 * Usage: node --import tsx scripts/proof-mantle-catalog-bound.mjs
 */
import { createServer } from "node:http";

const TARGET_BYTES = 24 * 1024 * 1024;
const PROVIDER_JSON_CAP = 16 * 1024 * 1024;

const { discoverMantleModels, resetMantleDiscoveryCacheForTest } =
  await import("../extensions/amazon-bedrock-mantle/api.ts");

let allPassed = true;

function check(label, val) {
  console.log(`  ${val ? "ok" : "FAIL"}: ${label} — ${val}`);
  if (!val) {
    allPassed = false;
  }
}

async function withCatalogServer(routes, fn) {
  let serverBytesSent = 0;
  const server = createServer((req, res) => {
    const route = routes[req.url ?? ""];
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    route(res, {
      trackWrite(chunk) {
        serverBytesSent += chunk.length;
      },
      getBytesSent: () => serverBytesSent,
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  try {
    await fn(port, () => serverBytesSent);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function streamHugeCatalogJson(res, trackWrite) {
  const chunk = Buffer.alloc(65536, 0x78);
  const prefix = Buffer.from('{"data":[{"id":"');
  const suffix = Buffer.from('","object":"model"}]}');
  res.writeHead(200, { "Content-Type": "application/json" });
  res.write(prefix);
  trackWrite(prefix);
  let sent = 0;
  function writeNext() {
    if (sent >= TARGET_BYTES) {
      res.write(suffix);
      trackWrite(suffix);
      res.end();
      return;
    }
    const ok = res.write(chunk);
    trackWrite(chunk);
    sent += chunk.length;
    if (ok) {
      setImmediate(writeNext);
    } else {
      res.once("drain", writeNext);
    }
  }
  writeNext();
}

function makeLocalFetchFn(port, path) {
  return async (url, init) => fetch(`http://127.0.0.1:${port}${path}`, init);
}

console.log("[case 1] discoverMantleModels + oversized /v1/models stream, no Content-Length");
await withCatalogServer(
  {
    "/huge": (res, { trackWrite }) => streamHugeCatalogJson(res, trackWrite),
  },
  async (port, getBytesSent) => {
    resetMantleDiscoveryCacheForTest();
    const models = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "proof-token",
      fetchFn: makeLocalFetchFn(port, "/huge"),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sent = getBytesSent();
    check("fail-soft fallback returns empty catalog when body exceeds cap", models.length === 0);
    check(
      `server stopped near ${Math.round(PROVIDER_JSON_CAP / (1024 * 1024))} MiB cap, not full ~24 MiB (sent ${sent})`,
      sent < PROVIDER_JSON_CAP * 1.5,
    );
    check(
      `server did not stream the entire hostile body (sent ${sent} < ${Math.round(TARGET_BYTES * 0.9)})`,
      sent < TARGET_BYTES * 0.9,
    );
  },
);

console.log("\n[case 2] discoverMantleModels + normal small catalog still parses");
await withCatalogServer(
  {
    "/small": (res, { trackWrite }) => {
      const body = JSON.stringify({
        data: [{ id: "anthropic.claude-sonnet-4-6", object: "model", owned_by: "anthropic" }],
      });
      const bytes = Buffer.from(body);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": bytes.length,
      });
      res.end(bytes);
      trackWrite(bytes);
    },
  },
  async (port) => {
    resetMantleDiscoveryCacheForTest();
    const models = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "proof-token",
      fetchFn: makeLocalFetchFn(port, "/small"),
    });
    check("small catalog returns one model", models.length === 1);
    check(
      `model id intact (${models[0]?.id ?? "(missing)"})`,
      models[0]?.id === "anthropic.claude-sonnet-4-6",
    );
  },
);

console.log(
  "\n[case 3] discoverMantleModels uses cached models after oversized stream when cache warm",
);
await withCatalogServer(
  {
    "/small": (res, { trackWrite }) => {
      const body = JSON.stringify({
        data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
      });
      const bytes = Buffer.from(body);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": bytes.length,
      });
      res.end(bytes);
      trackWrite(bytes);
    },
    "/huge": (res, { trackWrite }) => streamHugeCatalogJson(res, trackWrite),
  },
  async (port) => {
    resetMantleDiscoveryCacheForTest();
    let now = 1_000_000;
    const REFRESH_MS = 3_600_000;
    let callCount = 0;
    const fetchFn = async (url, init) => {
      callCount += 1;
      const path = callCount === 1 ? "/small" : "/huge";
      return fetch(`http://127.0.0.1:${port}${path}`, init);
    };

    const warm = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "proof-token",
      fetchFn,
      now: () => now,
    });
    check("warm cache populated from small catalog", warm.length === 1);

    now += REFRESH_MS + 1;
    const hostile = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "proof-token",
      fetchFn,
      now: () => now,
    });
    check("oversized stream falls back to cached models", hostile.length === 1);
    check(
      `cached model id preserved (${hostile[0]?.id ?? "(missing)"})`,
      hostile[0]?.id === "anthropic.claude-sonnet-4-6",
    );
    check("stale refresh re-fetched before bounded overflow fallback", callCount === 2);
  },
);

console.log(allPassed ? "\nALL PROOF ASSERTIONS PASSED" : "\nSOME ASSERTIONS FAILED");
process.exit(allPassed ? 0 : 1);
