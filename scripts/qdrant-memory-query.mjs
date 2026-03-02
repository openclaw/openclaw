#!/usr/bin/env node

const cfg = {
  enabled: String(process.env.OPENCLAW_QDRANT_MEMORY_ENABLED || "false").toLowerCase() === "true",
  qdrantUrl: (process.env.OPENCLAW_QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, ""),
  qdrantApiKey: process.env.OPENCLAW_QDRANT_API_KEY || "",
  collection: process.env.OPENCLAW_QDRANT_COLLECTION || "openclaw_memory",
  embeddingApiUrl:
    process.env.OPENCLAW_QDRANT_EMBEDDING_API_URL || "https://api.openai.com/v1/embeddings",
  embeddingApiKey:
    process.env.OPENCLAW_QDRANT_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || "",
  embeddingModel: process.env.OPENCLAW_QDRANT_EMBEDDING_MODEL || "text-embedding-3-small",
  limit: Number(process.env.OPENCLAW_QDRANT_QUERY_LIMIT || "5"),
};

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url} :: ${JSON.stringify(data)}`);
  }
  return data;
}

function qdrantHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (cfg.qdrantApiKey) headers["api-key"] = cfg.qdrantApiKey;
  return headers;
}

async function embed(input) {
  if (!cfg.embeddingApiKey) {
    throw new Error("OPENCLAW_QDRANT_EMBEDDING_API_KEY or OPENAI_API_KEY is required");
  }
  const data = await fetchJson(cfg.embeddingApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.embeddingApiKey}`,
    },
    body: JSON.stringify({ model: cfg.embeddingModel, input }),
  });
  return data?.data?.[0]?.embedding;
}

function buildFilter(kind, project) {
  const must = [];
  if (kind && kind !== "all") {
    must.push({ key: "kind", match: { value: kind } });
  }
  if (project) {
    must.push({ key: "project_id", match: { value: project } });
  }
  return must.length ? { must } : null;
}

async function search(vector, limit, filter) {
  const url = `${cfg.qdrantUrl}/collections/${cfg.collection}/points/search`;
  const body = { vector, limit, with_payload: true, with_vector: false };
  if (filter) body.filter = filter;
  return fetchJson(url, {
    method: "POST",
    headers: qdrantHeaders(),
    body: JSON.stringify(body),
  });
}

function trim(text, n = 220) {
  if (!text) return "";
  return text.length > n ? `${text.slice(0, n)}...` : text;
}

async function main() {
  const args = process.argv.slice(2);
  let json = false;
  let limit = cfg.limit;
  let kind = "all";
  let project = "";
  const queryParts = [];

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--limit" && i + 1 < args.length) {
      limit = Number(args[i + 1]) || cfg.limit;
      i += 1;
      continue;
    }
    if (a.startsWith("--limit=")) {
      limit = Number(a.split("=")[1]) || cfg.limit;
      continue;
    }
    if (a === "--kind" && i + 1 < args.length) {
      kind = args[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--kind=")) {
      kind = a.split("=")[1];
      continue;
    }
    if (a === "--project" && i + 1 < args.length) {
      project = args[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--project=")) {
      project = a.split("=")[1];
      continue;
    }
    queryParts.push(a);
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    process.stderr.write(
      "Usage: scripts/qdrant-memory-query.mjs [--json] [--limit N] [--kind all|memory|code] [--project id] <query>\n",
    );
    process.exit(1);
  }

  if (!cfg.enabled) {
    process.stderr.write("Qdrant memory sidecar disabled (OPENCLAW_QDRANT_MEMORY_ENABLED!=true).\n");
    process.exit(1);
  }

  const vector = await embed(query);
  if (!vector) throw new Error("Failed to compute embedding vector");

  const filter = buildFilter(kind, project);
  const out = await search(vector, limit, filter);
  const results = (out?.result || []).map((item) => ({
    score: Number(item?.score || 0),
    source: item?.payload?.source || "<unknown>",
    text: item?.payload?.text || "",
    chunk_index: item?.payload?.chunk_index ?? null,
    kind: item?.payload?.kind || "unknown",
    project_id: item?.payload?.project_id || null,
    rel_path: item?.payload?.rel_path || null,
  }));

  if (json) {
    process.stdout.write(`${JSON.stringify({ query, count: results.length, kind, project, results }, null, 2)}\n`);
    return;
  }

  if (!results.length) {
    process.stdout.write("No results.\n");
    return;
  }

  for (const [i, r] of results.entries()) {
    const suffix = r.project_id ? ` project=${r.project_id}` : "";
    process.stdout.write(`${i + 1}. score=${r.score.toFixed(4)} kind=${r.kind}${suffix} source=${r.source}\n`);
    process.stdout.write(`   ${trim(r.text)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err.message}\n`);
  process.exit(1);
});
