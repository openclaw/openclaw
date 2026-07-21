#!/usr/bin/env node
/**
 * Vector Search Benchmark
 * 
 * Compares Rust HNSW engine vs JavaScript sqlite-vec fallback
 * Tests: latency, throughput, memory usage, scalability
 */

import { performance } from 'perf_hooks';
import { createNativeVectorSearch } from '../src/mythos-native/vector-engine.js';
import chalk from 'chalk';
import Table from 'cli-table3';

// Configuration
const CONFIG = {
  dimensions: 1536,
  numVectors: [10000, 100000, 1000000],
  numQueries: 1000,
  topK: 10,
  warmupIterations: 10,
};

console.log(chalk.bold.cyan('\n🚀 Vector Search Benchmark\n'));
console.log(chalk.dim('Configuration:'));
console.log(`  Dimensions: ${CONFIG.dimensions}`);
console.log(`  Queries: ${CONFIG.numQueries}`);
console.log(`  Top-K: ${CONFIG.topK}\n`);

// Generate random vector
function generateRandomVector(dimensions) {
  const vector = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    vector[i] = Math.random() * 2 - 1;
  }
  // Normalize
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map(v => v / magnitude);
}

// Benchmark function
async function benchmarkVectorSearch(engine, name) {
  console.log(chalk.bold.yellow(`\nBenchmarking ${name}...\n`));
  
  const results = {
    engine: name,
    indexTimes: [],
    queryLatencies: [],
    throughput: [],
    memoryUsage: [],
  };
  
  for (const numVectors of CONFIG.numVectors) {
    console.log(chalk.dim(`Testing with ${numVectors.toLocaleString()} vectors...`));
    
    // Generate test data
    const vectors = [];
    const ids = [];
    const paths = [];
    const startLines = [];
    const endLines = [];
    
    for (let i = 0; i < numVectors; i++) {
      vectors.push(...generateRandomVector(CONFIG.dimensions));
      ids.push(`vec_${i}`);
      paths.push(`/test/file_${i}.md`);
      startLines.push(i * 10);
      endLines.push(i * 10 + 5);
    }
    
    // Benchmark index creation
    const indexStart = performance.now();
    const search = await createNativeVectorSearch({
      indexPath: `/tmp/benchmark_${name}_${numVectors}`,
      dimensions: CONFIG.dimensions,
    });
    
    if (search) {
      await search.addBatch(ids, vectors, paths, startLines, endLines);
    }
    const indexEnd = performance.now();
    const indexTime = indexEnd - indexStart;
    results.indexTimes.push({ numVectors, time: indexTime });
    
    console.log(chalk.green(`  ✓ Index creation: ${indexTime.toFixed(2)}ms`));
    
    // Warmup
    if (search) {
      for (let i = 0; i < CONFIG.warmupIterations; i++) {
        const query = generateRandomVector(CONFIG.dimensions);
        await search.search(query, CONFIG.topK);
      }
    }
    
    // Benchmark queries
    const queryLatencies = [];
    const queryStart = performance.now();
    
    for (let i = 0; i < CONFIG.numQueries; i++) {
      const query = generateRandomVector(CONFIG.dimensions);
      const queryIterStart = performance.now();
      
      if (search) {
        await search.search(query, CONFIG.topK);
      }
      
      const queryIterEnd = performance.now();
      queryLatencies.push(queryIterEnd - queryIterStart);
    }
    
    const queryEnd = performance.now();
    const totalTime = queryEnd - queryStart;
    const throughput = (CONFIG.numQueries / totalTime) * 1000;
    
    // Calculate percentiles
    queryLatencies.sort((a, b) => a - b);
    const p50 = queryLatencies[Math.floor(queryLatencies.length * 0.50)];
    const p90 = queryLatencies[Math.floor(queryLatencies.length * 0.90)];
    const p95 = queryLatencies[Math.floor(queryLatencies.length * 0.95)];
    const p99 = queryLatencies[Math.floor(queryLatencies.length * 0.99)];
    
    results.queryLatencies.push({
      numVectors,
      p50,
      p90,
      p95,
      p99,
      avg: queryLatencies.reduce((sum, v) => sum + v, 0) / queryLatencies.length,
    });
    
    results.throughput.push({
      numVectors,
      qps: throughput,
    });
    
    console.log(chalk.green(`  ✓ Query latency (p95): ${p95.toFixed(2)}ms`));
    console.log(chalk.green(`  ✓ Throughput: ${throughput.toFixed(0)} QPS`));
    
    // Memory usage
    if (process.memoryUsage) {
      const memUsage = process.memoryUsage();
      results.memoryUsage.push({
        numVectors,
        rss: memUsage.rss / 1024 / 1024,
        heap: memUsage.heapUsed / 1024 / 1024,
      });
      console.log(chalk.green(`  ✓ Memory (RSS): ${memUsage.rss / 1024 / 1024} MB`));
    }
    
    // Cleanup
    if (search && search.clear) {
      await search.clear();
    }
  }
  
  return results;
}

// Display results
function displayResults(rustResults, jsResults) {
  console.log(chalk.bold.cyan('\n📊 Benchmark Results\n'));
  
  // Index creation time comparison
  const indexTable = new Table({
    head: [
      chalk.cyan('Vectors'),
      chalk.cyan('Rust (ms)'),
      chalk.cyan('JS (ms)'),
      chalk.cyan('Speedup'),
    ],
    colWidths: [15, 15, 15, 15],
  });
  
  for (let i = 0; i < rustResults.indexTimes.length; i++) {
    const rust = rustResults.indexTimes[i];
    const js = jsResults.indexTimes[i];
    const speedup = js.time / rust.time;
    
    indexTable.push([
      rust.numVectors.toLocaleString(),
      rust.time.toFixed(2),
      js.time.toFixed(2),
      chalk.green(`${speedup.toFixed(1)}x`),
    ]);
  }
  
  console.log(chalk.bold.white('\nIndex Creation Time:'));
  console.log(indexTable.toString());
  
  // Query latency comparison
  const latencyTable = new Table({
    head: [
      chalk.cyan('Vectors'),
      chalk.cyan('Rust p95'),
      chalk.cyan('JS p95'),
      chalk.cyan('Speedup'),
    ],
    colWidths: [15, 15, 15, 15],
  });
  
  for (let i = 0; i < rustResults.queryLatencies.length; i++) {
    const rust = rustResults.queryLatencies[i];
    const js = jsResults.queryLatencies[i];
    const speedup = js.p95 / rust.p95;
    
    latencyTable.push([
      rust.numVectors.toLocaleString(),
      `${rust.p95.toFixed(2)}ms`,
      `${js.p95.toFixed(2)}ms`,
      chalk.green(`${speedup.toFixed(1)}x`),
    ]);
  }
  
  console.log(chalk.bold.white('\nQuery Latency (p95):'));
  console.log(latencyTable.toString());
  
  // Throughput comparison
  const throughputTable = new Table({
    head: [
      chalk.cyan('Vectors'),
      chalk.cyan('Rust QPS'),
      chalk.cyan('JS QPS'),
      chalk.cyan('Speedup'),
    ],
    colWidths: [15, 15, 15, 15],
  });
  
  for (let i = 0; i < rustResults.throughput.length; i++) {
    const rust = rustResults.throughput[i];
    const js = jsResults.throughput[i];
    const speedup = rust.qps / js.qps;
    
    throughputTable.push([
      rust.numVectors.toLocaleString(),
      rust.qps.toFixed(0),
      js.qps.toFixed(0),
      chalk.green(`${speedup.toFixed(1)}x`),
    ]);
  }
  
  console.log(chalk.bold.white('\nThroughput:'));
  console.log(throughputTable.toString());
  
  // Summary
  const avgSpeedup = rustResults.queryLatencies.reduce((sum, r, i) => {
    const js = jsResults.queryLatencies[i];
    return sum + (js.p95 / r.p95);
  }, 0) / rustResults.queryLatencies.length;
  
  console.log(chalk.bold.green(`\n✅ Average Speedup: ${avgSpeedup.toFixed(1)}x\n`));
  
  // Validation
  const passed = avgSpeedup >= 10;
  if (passed) {
    console.log(chalk.green('✅ PASS: Performance meets threshold (≥10x)'));
  } else {
    console.log(chalk.red('❌ FAIL: Performance below threshold (≥10x)'));
  }
  
  return { passed, avgSpeedup };
}

// Main
async function main() {
  try {
    console.log(chalk.dim('Running benchmarks...\n'));
    
    const rustResults = await benchmarkVectorSearch('rust', 'Rust HNSW');
    const jsResults = await benchmarkVectorSearch('javascript', 'JavaScript sqlite-vec');
    
    const { passed, avgSpeedup } = displayResults(rustResults, jsResults);
    
    // Save results
    const results = {
      timestamp: new Date().toISOString(),
      config: CONFIG,
      rust: rustResults,
      javascript: jsResults,
      summary: {
        avgSpeedup,
        passed,
      },
    };
    
    const fs = await import('fs');
    fs.writeFileSync(
      'benchmarks/results/vector-search-results.json',
      JSON.stringify(results, null, 2)
    );
    
    console.log(chalk.dim('\nResults saved to: benchmarks/results/vector-search-results.json'));
    
    process.exit(passed ? 0 : 1);
  } catch (error) {
    console.error(chalk.red('\n❌ Benchmark failed:'), error.message);
    process.exit(1);
  }
}

main();
