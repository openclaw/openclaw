#!/usr/bin/env bun
/**
 * Build a vector search index from docs/*.md for the docs-chat RAG pipeline.
 * Usage: bun build-vector-index.ts [--docs path/to/docs] [--base-url https://docs.openclaw.ai]
 *
 * Requires: OPENAI_API_KEY environment variable
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Embeddings } from "./rag/embeddings.js";
import { DocsStore, type DocsChunk } from "./rag/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const defaultDocsDir = path.join(root, "docs");
const defaultDbPath = path.join(__dirname, ".lance-db");

// Parse CLI arguments
const args = process.argv.slice(2);
let docsDir = defaultDocsDir;
let baseUrl = "https://docs.openclaw.ai";
let dbPath = defaultDbPath;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--docs" && args[i + 1]) {
    docsDir = path.resolve(args[++i]);
  } else if (args[i] === "--base-url" && args[i + 1]) {
    baseUrl = args[++i].replace(/\/$/, "");
  } else if (args[i] === "--db" && args[i + 1]) {
    dbPath = path.resolve(args[++i]);
  }
}

// Validate API key
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Error: OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

interface RawChunk {
  path: string;
  title: string;
  content: string;
  url: string;
}

// Chunking configuration for optimal RAG retrieval
// ~4 chars per token on average for English text
const TARGET_CHUNK_CHARS = 2400; // ~600 tokens
const MAX_CHUNK_CHARS = 4000; // ~1000 tokens
const OVERLAP_CHARS = 400; // ~100 tokens overlap

/**
 * Split a large chunk into smaller pieces with overlap.
 * Splits on paragraph boundaries when possible, falls back to sentence/word boundaries.
 */
function splitLargeChunk(chunk: RawChunk): RawChunk[] {
  const content = chunk.content;

  // If chunk is within limits, return as-is
  if (content.length <= MAX_CHUNK_CHARS) {
    return [chunk];
  }

  const results: RawChunk[] = [];
  const paragraphs = content.split(/\n\n+/);

  let currentContent = "";
  let partIndex = 0;

  const flushChunk = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    partIndex++;
    results.push({
      ...chunk,
      title: partIndex > 1 ? `${chunk.title} (part ${partIndex})` : chunk.title,
      content: trimmed,
    });
  };

  for (const para of paragraphs) {
    // If adding this paragraph would exceed max, flush current and start new
    if (
      currentContent.length > 0 &&
      currentContent.length + para.length + 2 > MAX_CHUNK_CHARS
    ) {
      flushChunk(currentContent);

      // Start new chunk with overlap from end of previous
      const overlapStart = Math.max(0, currentContent.length - OVERLAP_CHARS);
      // Find a good break point (paragraph or sentence boundary)
      let overlapText = currentContent.slice(overlapStart);
      const sentenceBreak = overlapText.search(/[.!?]\s+/);
      if (sentenceBreak > 0) {
        overlapText = overlapText.slice(sentenceBreak + 1).trim();
      }
      currentContent = overlapText;
    }

    // If a single paragraph exceeds max, split it further
    if (para.length > MAX_CHUNK_CHARS) {
      // Flush any accumulated content first
      if (currentContent.length > 0) {
        flushChunk(currentContent);
        currentContent = "";
      }

      // Split long paragraph on sentence boundaries
      const sentences = para.split(/(?<=[.!?])\s+/);
      let sentenceBuffer = "";

      for (const sentence of sentences) {
        if (
          sentenceBuffer.length > 0 &&
          sentenceBuffer.length + sentence.length + 1 > MAX_CHUNK_CHARS
        ) {
          flushChunk(sentenceBuffer);
          // Overlap from previous sentence buffer
          const overlapStart = Math.max(0, sentenceBuffer.length - OVERLAP_CHARS);
          sentenceBuffer = sentenceBuffer.slice(overlapStart).trim();
        }
        sentenceBuffer += (sentenceBuffer ? " " : "") + sentence;
      }

      if (sentenceBuffer) {
        currentContent = sentenceBuffer;
      }
    } else {
      currentContent += (currentContent ? "\n\n" : "") + para;
    }
  }

  // Flush remaining content
  if (currentContent.trim()) {
    flushChunk(currentContent);
  }

  return results;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  return content.slice(end + 4);
}

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden dirs, i18n, and non-English content
      if (
        entry.name === ".i18n" ||
        entry.name === "zh-CN" ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      files.push(...walk(full));
    } else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function extractChunks(filePath: string, content: string): RawChunk[] {
  const chunks: RawChunk[] = [];
  const lines = content.split(/\r?\n/);
  let currentTitle = "";
  let currentLines: string[] = [];

  const flush = (title: string, body: string) => {
    const text = body.trim();
    if (!text) return;
    const rel = path.relative(docsDir, filePath).replace(/\\/g, "/");
    const urlPath = rel.replace(/\.mdx?$/, "").replace(/^\/+/, "");
    chunks.push({
      path: rel,
      title: title || path.basename(rel, path.extname(rel)),
      content: text,
      url: `${baseUrl}/${urlPath}`,
    });
  };

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush(currentTitle, currentLines.join("\n"));
      currentTitle = heading[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush(currentTitle, currentLines.join("\n"));
  return chunks;
}

async function main() {
  console.error(`Scanning docs at: ${docsDir}`);

  // Collect all raw chunks from docs
  const rawChunks: RawChunk[] = [];
  for (const filePath of walk(docsDir)) {
    const raw = fs.readFileSync(filePath, "utf8");
    const body = stripFrontmatter(raw);
    rawChunks.push(...extractChunks(filePath, body));
  }

  console.error(`Found ${rawChunks.length} sections from docs`);

  // Split large chunks to stay within embedding model limits and improve retrieval
  const allRawChunks: RawChunk[] = [];
  for (const chunk of rawChunks) {
    allRawChunks.push(...splitLargeChunk(chunk));
  }

  console.error(
    `Split into ${allRawChunks.length} chunks (target: ~${TARGET_CHUNK_CHARS} chars, max: ${MAX_CHUNK_CHARS} chars, overlap: ${OVERLAP_CHARS} chars)`,
  );

  if (allRawChunks.length === 0) {
    console.error("No chunks found, exiting.");
    process.exit(0);
  }

  // Initialize embeddings with text-embedding-3-large for better retrieval quality
  const embeddings = new Embeddings(apiKey!);
  console.error(`Generating embeddings with model: text-embedding-3-large`);

  // Generate embeddings for all chunks
  // Use title + content for better semantic representation
  const textsToEmbed = allRawChunks.map(
    (chunk) => `${chunk.title}\n${chunk.content}`,
  );

  console.error(`Embedding ${textsToEmbed.length} chunks in batches...`);
  const vectors = await embeddings.embedBatch(textsToEmbed);

  // Create DocsChunk objects with embeddings
  const docsChunks: DocsChunk[] = allRawChunks.map((chunk, i) => ({
    id: randomUUID(),
    path: chunk.path,
    title: chunk.title,
    content: chunk.content,
    url: chunk.url,
    vector: vectors[i],
  }));

  // Store in LanceDB
  console.error(`Storing in LanceDB at: ${dbPath}`);
  const store = new DocsStore(dbPath, embeddings.dimensions);
  await store.replaceAll(docsChunks);

  const count = await store.count();
  console.error(`Done! Stored ${count} chunks in vector database.`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
