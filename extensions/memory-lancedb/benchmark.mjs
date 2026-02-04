#!/usr/bin/env node
/**
 * LanceDB performance benchmark
 */
import * as lancedb from "@lancedb/lancedb";
import OpenAI from "openai";

const LANCEDB_PATH = "/home/tsukhani/.openclaw/memory/lancedb";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function embed(text) {
  const start = Date.now();
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  const embedTime = Date.now() - start;
  return { vector: response.data[0].embedding, embedTime };
}

async function main() {
  console.log("📊 LanceDB Performance Benchmark");
  console.log("================================\n");

  // Connect
  const connectStart = Date.now();
  const db = await lancedb.connect(LANCEDB_PATH);
  const table = await db.openTable("memories");
  const connectTime = Date.now() - connectStart;
  console.log(`Connection time: ${connectTime}ms`);

  const count = await table.countRows();
  console.log(`Total memories: ${count}\n`);

  // Test queries
  const queries = [
    "Tarun's preferences",
    "What is the OpenRouter API key location?",
    "meeting schedule",
    "Abundent Academy training",
    "slate blue",
  ];

  console.log("Search benchmarks (5 runs each, limit=5):\n");

  for (const query of queries) {
    const times = [];
    let embedTime = 0;

    for (let i = 0; i < 5; i++) {
      const { vector, embedTime: et } = await embed(query);
      embedTime = et; // Last one

      const searchStart = Date.now();
      const _results = await table.vectorSearch(vector).limit(5).toArray();
      const searchTime = Date.now() - searchStart;
      times.push(searchTime);
    }

    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const min = Math.min(...times);
    const max = Math.max(...times);

    console.log(`"${query}"`);
    console.log(`  Embedding: ${embedTime}ms`);
    console.log(`  Search:    avg=${avg}ms, min=${min}ms, max=${max}ms`);
    console.log("");
  }

  // Raw vector search (no embedding)
  console.log("\nRaw vector search (pre-computed embedding):");
  const { vector } = await embed("test query");
  const rawTimes = [];
  for (let i = 0; i < 10; i++) {
    const start = Date.now();
    await table.vectorSearch(vector).limit(5).toArray();
    rawTimes.push(Date.now() - start);
  }
  const avgRaw = Math.round(rawTimes.reduce((a, b) => a + b, 0) / rawTimes.length);
  console.log(`  avg=${avgRaw}ms, min=${Math.min(...rawTimes)}ms, max=${Math.max(...rawTimes)}ms`);
}

main().catch(console.error);
