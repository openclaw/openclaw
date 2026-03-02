/**
 * Vitest benchmarks for context-mode hot paths:
 * compression, knowledge-base operations, signal extraction, and FTS5 search at scale.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, bench, describe } from "vitest";
import { compressToolResult, resetRefCounter } from "./compressor.js";
import { openKnowledgeBase, type KnowledgeBase } from "./knowledge-base.js";
import { DEFAULT_CONFIG, type ContextModeConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers — reusable fixtures
// ---------------------------------------------------------------------------

const config: ContextModeConfig = { ...DEFAULT_CONFIG, summaryHeadChars: 500 };

function generatePlainText(chars: number): string {
  const line = "The quick brown fox jumps over the lazy dog. ";
  const repeats = Math.ceil(chars / line.length);
  return line.repeat(repeats).slice(0, chars);
}

function generateJsonArray(targetChars: number): string {
  const items: Record<string, unknown>[] = [];
  let total = 2; // "[]"
  let i = 0;
  while (total < targetChars) {
    const item = {
      id: i,
      name: `item-${i}`,
      email: `user${i}@example.com`,
      status: i % 3 === 0 ? "active" : i % 3 === 1 ? "pending" : "inactive",
      score: Math.round(Math.random() * 1000) / 10,
    };
    const encoded = JSON.stringify(item);
    total += encoded.length + (items.length > 0 ? 1 : 0); // comma
    items.push(item);
    i++;
  }
  return JSON.stringify(items);
}

function generateJsonObject(targetChars: number): string {
  const obj: Record<string, unknown> = {};
  let total = 2; // "{}"
  let i = 0;
  while (total < targetChars) {
    const key = `section_${i}`;
    const nested: Record<string, unknown> = {};
    for (let j = 0; j < 5; j++) {
      nested[`field_${j}`] = `value_${i}_${j}_${"x".repeat(40)}`;
    }
    const entry = JSON.stringify({ [key]: nested });
    total += entry.length - 2 + (i > 0 ? 1 : 0);
    obj[key] = nested;
    i++;
  }
  return JSON.stringify(obj);
}

function generateTextWithSignals(chars: number): string {
  const lines: string[] = [];
  let total = 0;
  let i = 0;
  while (total < chars) {
    let line: string;
    if (i % 10 === 0) {
      line = `Error: connection refused on attempt ${i} — retrying`;
    } else if (i % 7 === 0) {
      line = `See https://example.com/docs/page-${i} for details`;
    } else if (i % 13 === 0) {
      line = `total: ${i * 10}, results: ${i}, rows: ${i * 2}`;
    } else {
      line = `Log line ${i}: ${"a".repeat(60)}`;
    }
    lines.push(line);
    total += line.length + 1;
    i++;
  }
  return lines.join("\n").slice(0, chars);
}

// Pre-generate fixtures so allocation is not part of the bench loop
const smallText = generatePlainText(100);
const mediumText = generatePlainText(5_000);
const largeText = generatePlainText(50_000);
const largeJsonArray = generateJsonArray(50_000);
const largeJsonObject = generateJsonObject(50_000);
const textWithSignals = generateTextWithSignals(50_000);
const hugeText = generatePlainText(120_000); // > 100KB — should skip JSON.parse

// ---------------------------------------------------------------------------
// 1. Compression benchmarks
// ---------------------------------------------------------------------------

describe("compressToolResult", () => {
  bench("small text (100 chars)", () => {
    resetRefCounter();
    compressToolResult(smallText, "bash", config);
  });

  bench("medium text (5KB)", () => {
    resetRefCounter();
    compressToolResult(mediumText, "bash", config);
  });

  bench("large text (50KB)", () => {
    resetRefCounter();
    compressToolResult(largeText, "bash", config);
  });

  bench("large JSON array (50KB)", () => {
    resetRefCounter();
    compressToolResult(largeJsonArray, "api_call", config);
  });

  bench("large JSON object (50KB)", () => {
    resetRefCounter();
    compressToolResult(largeJsonObject, "api_call", config);
  });

  bench("text with URLs, errors, counts (50KB)", () => {
    resetRefCounter();
    compressToolResult(textWithSignals, "bash", config);
  });

  bench("huge text >100KB (skip JSON.parse)", () => {
    resetRefCounter();
    compressToolResult(hugeText, "bash", config);
  });
});

// ---------------------------------------------------------------------------
// 2. Knowledge base operations
// ---------------------------------------------------------------------------

const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-bench-"));
let kb: KnowledgeBase;

try {
  kb = openKnowledgeBase(kbDir);
} catch {
  // node:sqlite unavailable — skip KB benchmarks gracefully
  console.warn("node:sqlite unavailable; knowledge-base benchmarks will be skipped");
  kb = undefined as unknown as KnowledgeBase;
}

// Seed a baseline entry for retrieve/search benchmarks
if (kb) {
  kb.store({
    refId: "bench_seed_0",
    toolName: "bash",
    toolCallId: "call_seed_0",
    originalChars: 5000,
    compressedChars: 200,
    fullText: generatePlainText(5000),
    timestamp: Date.now(),
  });
}

describe("KnowledgeBase", () => {
  if (!kb) return;

  let storeCounter = 1000;

  bench("store()", () => {
    const id = `bench_store_${storeCounter++}`;
    kb.store({
      refId: id,
      toolName: "bash",
      toolCallId: `call_${id}`,
      originalChars: 5000,
      compressedChars: 200,
      fullText: mediumText,
      timestamp: Date.now(),
    });
  });

  bench("retrieve() — hit", () => {
    kb.retrieve("bench_seed_0");
  });

  bench("retrieve() — miss", () => {
    kb.retrieve("nonexistent_ref");
  });

  bench("search() — single term", () => {
    kb.search("quick", 10);
  });

  bench("search() — multi term", () => {
    kb.search("quick brown fox", 10);
  });

  bench("listRecent(20)", () => {
    kb.listRecent(20);
  });

  bench("stats()", () => {
    kb.stats();
  });
});

// ---------------------------------------------------------------------------
// 3. Signal extraction (through compressToolResult)
// ---------------------------------------------------------------------------

describe("signal extraction", () => {
  // Text densely packed with URLs, errors, and count patterns
  const denseSignals = [
    ...Array.from({ length: 20 }, (_, i) => `https://api.example.com/v2/resource/${i}?token=abc`),
    ...Array.from({ length: 10 }, (_, i) => `Error: timeout after ${i * 100}ms on host-${i}`),
    ...Array.from({ length: 10 }, (_, i) => `total: ${i * 1000}, items: ${i * 50}`),
    generatePlainText(40_000),
  ].join("\n");

  bench("dense signals (URLs + errors + counts, 40KB+)", () => {
    resetRefCounter();
    compressToolResult(denseSignals, "bash", config);
  });
});

// ---------------------------------------------------------------------------
// 4. FTS5 search at scale — 100 entries
// ---------------------------------------------------------------------------

describe("FTS5 search at scale (100 entries)", () => {
  const scaleDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-bench-scale-"));
  let scaleKb: KnowledgeBase;

  try {
    scaleKb = openKnowledgeBase(scaleDir);
  } catch {
    console.warn("node:sqlite unavailable; FTS5 scale benchmarks will be skipped");
    scaleKb = undefined as unknown as KnowledgeBase;
  }

  if (!scaleKb) return;

  // Seed 100 entries with varied content
  const topics = [
    "authentication",
    "database",
    "networking",
    "filesystem",
    "compression",
    "encryption",
    "parsing",
    "serialization",
    "validation",
    "routing",
  ];

  for (let i = 0; i < 100; i++) {
    const topic = topics[i % topics.length]!;
    const text = [
      `Module: ${topic} handler (entry ${i})`,
      `This ${topic} component processes requests efficiently.`,
      `Error: ${topic} timeout after ${i * 10}ms`,
      `https://docs.example.com/${topic}/guide`,
      generatePlainText(500 + i * 10),
    ].join("\n");

    scaleKb.store({
      refId: `scale_${i}`,
      toolName: i % 2 === 0 ? "bash" : "api_call",
      toolCallId: `call_scale_${i}`,
      originalChars: text.length,
      compressedChars: 200,
      fullText: text,
      timestamp: Date.now() - (100 - i) * 1000,
    });
  }

  bench("search — common term", () => {
    scaleKb.search("authentication", 10);
  });

  bench("search — rare term", () => {
    scaleKb.search("encryption", 10);
  });

  bench("search — multi-word", () => {
    scaleKb.search("database timeout", 10);
  });

  bench("search — no results", () => {
    scaleKb.search("xyznonexistent", 10);
  });

  bench("listRecent(50)", () => {
    scaleKb.listRecent(50);
  });

  bench("stats()", () => {
    scaleKb.stats();
  });

  afterAll(() => {
    scaleKb.close();
    fs.rmSync(scaleDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
  if (kb) {
    kb.close();
  }
  fs.rmSync(kbDir, { recursive: true, force: true });
});
