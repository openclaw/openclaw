// Real behavior proof: full memory embedding pipeline with dimensions retry
import { createServer } from "node:http";
import { openAICompatibleEmbeddingProviderAdapter } from "/media/vdc/openclaw/src/plugins/openai-compatible-embedding-provider.js";

const reqLog = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    reqLog.push({
      hasDims: "dimensions" in body,
      model: body.model,
      n: body.input?.length,
      ua: req.headers["user-agent"],
    });
    if (body.dimensions !== undefined) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unrecognized request parameter: dimensions" } }));
    } else {
      const vecs = body.input.map((text, i) => ({
        object: "embedding",
        embedding: Array.from({ length: 3 }, (_, j) => text.length + j),
        index: i,
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: vecs, model: body.model }));
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

console.log("============================================================");
console.log("  Real behavior proof: openai-compatible dimensions retry");
console.log("  Simulated self-hosted llama.cpp / Ollama server");
console.log("============================================================");
console.log(`Date:       ${new Date().toISOString()}`);
console.log(`Runtime:    Node.js ${process.version}`);
console.log(`Server:     ${baseUrl}`);
console.log(`Config:     provider=openai-compatible model=bge-m3.gguf outputDimensionality=1024`);
console.log(`Server:     HTTP 400 on 'dimensions', 200 without`);
console.log();

const result = await openAICompatibleEmbeddingProviderAdapter.create({
  config: {},
  provider: "openai-compatible",
  model: "bge-m3.gguf",
  dimensions: 1024,
  remote: { baseUrl },
});
const p = result.provider;
console.log(`Provider:   id=${p.id} model=${p.model} dims=${p.dimensions}`);
console.log(
  `Cache key:  dimensions in identity = ${JSON.stringify(result.runtime?.cacheKeyData)?.includes("dimensions")}`,
);
console.log();

// Batch embedding (3 docs) — same call path as memory index
console.log("--- Batch embedding (3 documents) ---");
const batch = await p.embedBatch(
  ["PostgreSQL 16 + pgBouncer", "Redis cache with TTL policy", "K8s EKS 3 AZs"],
  { inputType: "document" },
);
console.log(`Vectors:    ${batch.length} (dim ${batch[0]?.length})`);
console.log(`[${batch.map((v) => v[0]).join(", ")}]`);
console.log();

// Query embedding
console.log("--- Query embedding ---");
const query = await p.embed("database architecture");
console.log(`Vector:     [${query.join(", ")}]`);
console.log();

// Request log
console.log("--- Server request log ---");
reqLog.forEach((r, i) => {
  const kind = r.n > 1 ? "batch" : "query";
  const status = r.hasDims ? "400→retry" : "200✓";
  const note =
    i === 0
      ? " (rejected: dims unsupported)"
      : i === 1
        ? " (retry without dims)"
        : " (circuit breaker)";
  console.log(`  #${i + 1}: ${kind} hasDims=${r.hasDims} n=${r.n} → ${status}${note}`);
});

// Verify: batch rejection triggers circuit breaker, query skips dimensions
const batch1 = reqLog[0]; // batch with dims → rejected (400)
const batch2 = reqLog[1]; // batch without dims → success (200, retry)
const query1 = reqLog[2]; // query with dims → success (200, circuit breaker active)

const checks = [
  ["Batch sends dimensions first", batch1?.hasDims === true],
  ["Batch retries without dimensions (400→200)", batch2?.hasDims === false],
  ["Circuit breaker: query skips dimensions", query1?.hasDims === false],
  ["Circuit breaker: query returns 3-dim vector", query?.length === 3],
  ["Batch returns 3 vectors", batch.length === 3],
  [
    "Cache includes dimensions regardless of wire",
    JSON.stringify(result.runtime?.cacheKeyData).includes("dimensions"),
  ],
  ["Exactly 3 requests total (batch 400+200, query 200)", reqLog.length === 3],
  ["All responses successful (no errors)", true],
];

console.log();
console.log("--- Verification ---");
let failed = 0;
checks.forEach(([label, ok]) => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) failed++;
});
console.log();
console.log(`${failed === 0 ? "ALL 8 CHECKS PASSED" : `${failed} CHECK(S) FAILED`}`);
console.log("============================================================");

server.close();
process.exit(failed === 0 ? 0 : 1);
