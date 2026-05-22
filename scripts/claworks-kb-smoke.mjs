#!/usr/bin/env node
/**
 * KB smoke: status → ingest → flush → search (requires running gateway with claworks-robot).
 *
 *   CLAWORKS_API_KEY=... pnpm claworks:kb-smoke
 *   CLAWORKS_BASE_URL=http://127.0.0.1:18800 pnpm claworks:kb-smoke
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveBaseUrl() {
  const explicit =
    process.env.CLAWORKS_BASE_URL?.trim() || process.env.CLAWORKS_GATEWAY_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }
  const port = process.env.CLAWORKS_GATEWAY_PORT?.trim() || "18800";
  return `http://127.0.0.1:${port}`;
}

function resolveApiKey() {
  const fromEnv = process.env.CLAWORKS_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    join(process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".claworks"), "claworks.json");
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return config.gateway?.auth?.token?.trim();
  } catch {
    return undefined;
  }
}

const base = resolveBaseUrl();
const apiKey = resolveApiKey();

async function jfetch(path, init = {}) {
  const headers = { "content-type": "application/json", ...(init.headers ?? {}) };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const marker = `claworks-kb-smoke-${Date.now()}`;

console.log(`[kb-smoke] base=${base}`);
const status = await jfetch("/v1/kb/status");
console.log("[kb-smoke] status:", status);
if (!status.vector) {
  console.warn(
    "[kb-smoke] vector=false — run: pnpm claworks:repair:personal && pnpm claworks:runtime:build",
  );
}

await jfetch("/v1/kb/ingest", {
  method: "POST",
  body: JSON.stringify({
    text: `Smoke test document. Unique marker: ${marker}`,
    source: "claworks-kb-smoke",
    namespace: "smoke",
  }),
});
console.log("[kb-smoke] ingested");

const flush = await jfetch("/v1/kb/flush", { method: "POST", body: "{}" });
console.log("[kb-smoke] flush:", flush);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let hits = [];
for (let attempt = 1; attempt <= 8; attempt++) {
  const search = await jfetch(
    `/v1/kb/search?q=${encodeURIComponent(marker)}&limit=5&namespace=smoke`,
  );
  hits = search.results ?? [];
  if (hits.length > 0) {
    console.log(`[kb-smoke] search ok (attempt ${attempt}):`, hits[0]);
    break;
  }
  if (attempt < 8) {
    await sleep(2000);
  } else {
    console.warn("[kb-smoke] search:", search);
  }
}
if (!hits.length) {
  const dropDir = status.kb_drop_dir;
  let dropOk = false;
  if (dropDir && existsSync(dropDir)) {
    const smokeDir = join(dropDir, "smoke");
    if (existsSync(smokeDir)) {
      const recent = readdirSync(smokeDir).filter((n) => n.endsWith(".md"));
      dropOk = recent.length > 0;
    }
  }
  if (dropOk) {
    console.warn(
      "[kb-smoke] ingest+flush OK and kb-drop file present, but vector search returned no hits — check embedding API / LanceDB sync",
    );
  } else {
    console.warn(
      "[kb-smoke] no hits and no kb-drop artifact — check memory-lancedb embedding baseUrl/model and gateway logs",
    );
    console.warn("[kb-smoke] status:", status);
    process.exitCode = 1;
  }
}
