#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MEMORY_DIR = path.join(ROOT_DIR, "memory");
const STATE_FILE = path.join(MEMORY_DIR, "qdrant-index-state.json");

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
  embeddingDim: Number(process.env.OPENCLAW_QDRANT_EMBEDDING_DIM || "1536"),
  batchSize: Number(process.env.OPENCLAW_QDRANT_BATCH_SIZE || "32"),
  chunkChars: Number(process.env.OPENCLAW_QDRANT_CHUNK_CHARS || "1200"),
  codeIndexEnabled:
    String(process.env.OPENCLAW_QDRANT_CODE_INDEX_ENABLED || "false").toLowerCase() === "true",
  codeProjectsFile:
    process.env.OPENCLAW_QDRANT_CODE_PROJECTS_FILE || path.join(ROOT_DIR, "qdrant-setup", "projects.json"),
  codeProjectPaths: process.env.OPENCLAW_QDRANT_CODE_PROJECT_PATHS || "",
  codeExtensions: new Set(
    (process.env.OPENCLAW_QDRANT_CODE_EXTENSIONS ||
      ".ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.go,.rs,.java,.kt,.swift,.dart,.sql,.sh,.yaml,.yml,.json,.md")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
  codeIgnoreDirs: new Set(
    (process.env.OPENCLAW_QDRANT_CODE_IGNORE_DIRS ||
      "node_modules,.git,dist,build,.next,.nuxt,.pnpm-store,coverage,.turbo,.cache,vendor,tmp")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  codeMaxFileBytes: Number(process.env.OPENCLAW_QDRANT_CODE_MAX_FILE_BYTES || "262144"),
  codeMaxFiles: Number(process.env.OPENCLAW_QDRANT_CODE_MAX_FILES || "5000"),
};

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function hexToUuid(hex) {
  const h = hex.slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function chunkText(text, maxChars) {
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";

  for (const p of paragraphs) {
    if (!current) {
      if (p.length <= maxChars) {
        current = p;
      } else {
        for (let i = 0; i < p.length; i += maxChars) chunks.push(p.slice(i, i + maxChars));
      }
      continue;
    }

    const candidate = `${current}\n\n${p}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    chunks.push(current);
    if (p.length <= maxChars) {
      current = p;
    } else {
      current = "";
      for (let i = 0; i < p.length; i += maxChars) {
        const part = p.slice(i, i + maxChars);
        if (part.length === maxChars) chunks.push(part);
        else current = part;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function isLikelyBinary(buf) {
  const max = Math.min(buf.length, 8000);
  for (let i = 0; i < max; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

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

function embeddingHeaders() {
  if (!cfg.embeddingApiKey) {
    throw new Error("OPENCLAW_QDRANT_EMBEDDING_API_KEY or OPENAI_API_KEY is required");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.embeddingApiKey}`,
  };
}

async function ensureCollection() {
  const url = `${cfg.qdrantUrl}/collections/${cfg.collection}`;
  try {
    await fetchJson(url, {
      method: "PUT",
      headers: qdrantHeaders(),
      body: JSON.stringify({ vectors: { size: cfg.embeddingDim, distance: "Cosine" } }),
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("HTTP 409")) return;
    throw err;
  }
}

async function deleteByFilter(filter) {
  const url = `${cfg.qdrantUrl}/collections/${cfg.collection}/points/delete?wait=true`;
  await fetchJson(url, {
    method: "POST",
    headers: qdrantHeaders(),
    body: JSON.stringify({ filter }),
  });
}

async function deleteBySource(source) {
  await deleteByFilter({ must: [{ key: "source", match: { value: source } }] });
}

async function deleteByKindAndProject(kind, projectId) {
  await deleteByFilter({
    must: [
      { key: "kind", match: { value: kind } },
      { key: "project_id", match: { value: projectId } },
    ],
  });
}

async function embed(text) {
  const data = await fetchJson(cfg.embeddingApiUrl, {
    method: "POST",
    headers: embeddingHeaders(),
    body: JSON.stringify({ model: cfg.embeddingModel, input: text }),
  });
  if (!data?.data?.[0]?.embedding) {
    throw new Error(`Invalid embedding response: ${JSON.stringify(data)}`);
  }
  return data.data[0].embedding;
}

async function upsertPoints(points) {
  if (!points.length) return;
  const url = `${cfg.qdrantUrl}/collections/${cfg.collection}/points?wait=true`;
  await fetchJson(url, {
    method: "PUT",
    headers: qdrantHeaders(),
    body: JSON.stringify({ points }),
  });
}

async function collectMemoryFiles() {
  const files = [];
  for (const rel of ["MEMORY.md", path.join("memory", `${new Date().toISOString().slice(0, 10)}.md`)]) {
    const abs = path.join(ROOT_DIR, rel);
    try {
      await fs.access(abs);
      files.push(abs);
    } catch {
      // skip
    }
  }

  try {
    const entries = await fs.readdir(MEMORY_DIR, { withFileTypes: true });
    for (const e of entries
      .filter((x) => x.isFile() && x.name.endsWith(".md"))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(MEMORY_DIR, e.name);
      if (!files.includes(p)) files.push(p);
    }
  } catch {
    // skip
  }

  return files;
}

function parseCsvPaths(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => ({ id: path.basename(p), path: p, enabled: true }));
}

async function loadCodeProjects() {
  const projects = [];

  if (cfg.codeProjectPaths.trim()) {
    projects.push(...parseCsvPaths(cfg.codeProjectPaths));
  }

  try {
    const raw = await fs.readFile(cfg.codeProjectsFile, "utf8");
    const parsed = JSON.parse(raw);
    const fromFile = Array.isArray(parsed?.projects) ? parsed.projects : [];
    for (const p of fromFile) {
      if (!p || typeof p !== "object") continue;
      const projectPath = String(p.path || "").trim();
      if (!projectPath) continue;
      projects.push({
        id: String(p.id || path.basename(projectPath)).trim() || path.basename(projectPath),
        path: projectPath,
        enabled: p.enabled !== false,
      });
    }
  } catch {
    // no projects file is fine
  }

  const seen = new Set();
  const out = [];
  for (const p of projects) {
    if (!p.enabled) continue;
    const abs = path.isAbsolute(p.path) ? p.path : path.resolve(ROOT_DIR, p.path);
    const key = `${p.id}::${abs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const st = await fs.stat(abs);
      if (!st.isDirectory()) continue;
      out.push({ id: p.id, root: abs });
    } catch {
      // missing path, skip
    }
  }
  return out;
}

async function* walkProjectFiles(projectRoot) {
  const stack = [projectRoot];
  while (stack.length) {
    const dir = stack.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (cfg.codeIgnoreDirs.has(entry.name)) continue;
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!cfg.codeExtensions.has(ext)) continue;

      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        continue;
      }
      if (st.size > cfg.codeMaxFileBytes) continue;

      yield abs;
    }
  }
}

async function collectCodeDocuments(project) {
  const docs = [];
  let scanned = 0;

  for await (const abs of walkProjectFiles(project.root)) {
    if (scanned >= cfg.codeMaxFiles) break;
    scanned += 1;

    let buf;
    try {
      buf = await fs.readFile(abs);
    } catch {
      continue;
    }

    if (isLikelyBinary(buf)) continue;
    const text = buf.toString("utf8");
    if (!text.trim()) continue;

    const rel = path.relative(project.root, abs);
    const source = `code:${project.id}:${rel}`;
    docs.push({
      source,
      text,
      meta: {
        kind: "code",
        project_id: project.id,
        project_root: project.root,
        rel_path: rel,
      },
    });
  }

  return docs;
}

async function indexDocuments(docs) {
  let totalChunks = 0;
  const points = [];

  for (const doc of docs) {
    const chunks = chunkText(doc.text, cfg.chunkChars);
    totalChunks += chunks.length;

    for (let i = 0; i < chunks.length; i += 1) {
      const text = chunks[i];
      const vector = await embed(text);
      const id = hexToUuid(sha256(`${doc.source}\n${i}\n${text}`));
      points.push({
        id,
        vector,
        payload: {
          source: doc.source,
          chunk_index: i,
          text,
          updated_at: new Date().toISOString(),
          ...(doc.meta || {}),
        },
      });

      if (points.length >= cfg.batchSize) {
        await upsertPoints(points.splice(0, points.length));
      }
    }
  }

  if (points.length) await upsertPoints(points);
  return totalChunks;
}

async function writeState(summary) {
  const nowTs = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();
  await fs.mkdir(MEMORY_DIR, { recursive: true });
  await fs.writeFile(
    STATE_FILE,
    `${JSON.stringify({ last_index_ts: nowTs, last_index_iso: nowIso, ...summary }, null, 2)}\n`,
    "utf8",
  );
}

async function main() {
  if (!cfg.enabled) {
    log("Qdrant memory sidecar disabled (OPENCLAW_QDRANT_MEMORY_ENABLED!=true). No action.");
    return;
  }

  log(`Ensuring Qdrant collection '${cfg.collection}'...`);
  await ensureCollection();

  const memoryFiles = await collectMemoryFiles();
  let memoryChunks = 0;

  if (memoryFiles.length) {
    log(`Indexing memory files (${memoryFiles.length})...`);
    for (const file of memoryFiles) {
      const source = path.relative(ROOT_DIR, file);
      log(`- Refresh memory source: ${source}`);
      await deleteBySource(source);
      const raw = await fs.readFile(file, "utf8");
      const docs = [{ source, text: raw, meta: { kind: "memory" } }];
      memoryChunks += await indexDocuments(docs);
    }
  }

  let codeProjectsIndexed = 0;
  let codeFilesIndexed = 0;
  let codeChunksIndexed = 0;

  if (cfg.codeIndexEnabled) {
    const projects = await loadCodeProjects();
    log(`Code indexing enabled. projects=${projects.length}`);

    for (const project of projects) {
      log(`- Refresh project: ${project.id} (${project.root})`);
      await deleteByKindAndProject("code", project.id);
      const docs = await collectCodeDocuments(project);
      codeProjectsIndexed += 1;
      codeFilesIndexed += docs.length;
      log(`  files indexed: ${docs.length}`);
      codeChunksIndexed += await indexDocuments(docs);
    }
  }

  await writeState({
    memory_files_indexed: memoryFiles.length,
    memory_chunks_indexed: memoryChunks,
    code_projects_indexed: codeProjectsIndexed,
    code_files_indexed: codeFilesIndexed,
    code_chunks_indexed: codeChunksIndexed,
    files_indexed: memoryFiles.length + codeFilesIndexed,
    chunks_indexed: memoryChunks + codeChunksIndexed,
  });

  log(
    `Qdrant indexing complete. memory_files=${memoryFiles.length}, memory_chunks=${memoryChunks}, code_projects=${codeProjectsIndexed}, code_files=${codeFilesIndexed}, code_chunks=${codeChunksIndexed}`,
  );
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err.message}\n`);
  process.exit(1);
});
