#!/usr/bin/env node
'use strict';

/**
 * CLI for testing RAG queries against the local index.
 *
 * Usage:
 *   node query-cli.js "your search query"
 *   node query-cli.js "your search query" --threshold 0.4
 *   node query-cli.js "your search query" --max 3
 */

const rag = require('./rag-query');

async function main() {
  const args = process.argv.slice(2);
  const opts = {};

  // Parse flags
  const queryParts = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--threshold' && args[i + 1]) {
      opts.threshold = parseFloat(args[++i]);
    } else if (args[i] === '--max' && args[i + 1]) {
      opts.maxResults = parseInt(args[++i], 10);
    } else {
      queryParts.push(args[i]);
    }
  }

  const query = queryParts.join(' ');
  if (!query) {
    console.error('Usage: node query-cli.js "your search query" [--threshold 0.4] [--max 3]');
    process.exit(1);
  }

  console.log(`Query: "${query}"\n`);

  const t0 = Date.now();
  const results = await rag.search(query, opts);
  const searchTime = Date.now() - t0;

  if (results.length === 0) {
    console.log('No results above threshold.');
    console.log(`(Search took ${searchTime}ms)`);
    return;
  }

  console.log(`Found ${results.length} results (${searchTime}ms):\n`);
  for (const r of results) {
    console.log(`  [${r.similarity.toFixed(4)}] ${r.path}`);
    console.log(`           ${r.title}`);
    console.log(`           ${r.text.slice(0, 100).replace(/\n/g, ' ')}...`);
    console.log();
  }

  // Show injection preview
  const config = rag.loadConfig();
  const files = rag.getFullFiles(results, config.workspaceRoot);
  const injection = rag.formatForInjection(files);
  if (injection) {
    console.log('--- Injection preview (first 500 chars) ---');
    console.log(injection.slice(0, 500));
    console.log(`\n--- Total injection: ${injection.length} chars ---`);
  }
}

main().catch(err => {
  console.error('Query failed:', err);
  process.exit(1);
});
