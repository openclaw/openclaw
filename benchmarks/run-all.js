#!/usr/bin/env node
/**
 * Mythos Benchmark Runner
 * 
 * Executes all benchmarks and generates comprehensive reports
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import chalk from 'chalk';
import Table from 'cli-table3';

console.log(chalk.bold.cyan('\n🦞 Mythos Performance Benchmark Suite\n'));

// Parse arguments
const args = process.argv.slice(2);
const options = {
  html: args.includes('--html'),
  ci: args.includes('--ci'),
  compare: args.includes('--compare'),
  baseline: args.find((a, i) => args[i - 1] === '--compare'),
};

// Create results directory
const resultsDir = 'benchmarks/results';
if (!existsSync(resultsDir)) {
  mkdirSync(resultsDir, { recursive: true });
}

// Benchmark scripts
const benchmarks = [
  {
    name: 'Vector Search',
    script: 'benchmarks/vector-search-benchmark.js',
    threshold: 10,
  },
  {
    name: 'Text Search',
    script: 'benchmarks/text-search-benchmark.js',
    threshold: 10,
  },
  {
    name: 'Embedding Generation',
    script: 'benchmarks/embedding-benchmark.js',
    threshold: 50,
  },
  {
    name: 'Protocol Codec',
    script: 'benchmarks/protocol-benchmark.js',
    threshold: 5,
  },
  {
    name: 'A2A Protocol',
    script: 'benchmarks/a2a-benchmark.js',
    threshold: 5,
  },
];

const results = [];
let allPassed = true;

console.log(chalk.dim('Running benchmarks...\n'));

for (const benchmark of benchmarks) {
  console.log(chalk.bold.yellow(`\n${'='.repeat(60)}`));
  console.log(chalk.bold.yellow(`Running: ${benchmark.name}`));
  console.log(chalk.bold.yellow(`${'='.repeat(60)}\n`));
  
  try {
    const output = execSync(`node ${benchmark.script}`, {
      encoding: 'utf-8',
      stdio: 'inherit',
    });
    
    results.push({
      name: benchmark.name,
      status: 'passed',
      threshold: benchmark.threshold,
    });
    
    console.log(chalk.green(`\n✅ ${benchmark.name}: PASSED\n`));
  } catch (error) {
    results.push({
      name: benchmark.name,
      status: 'failed',
      threshold: benchmark.threshold,
      error: error.message,
    });
    
    console.log(chalk.red(`\n❌ ${benchmark.name}: FAILED\n`));
    allPassed = false;
  }
}

// Display summary
console.log(chalk.bold.cyan('\n📊 Benchmark Summary\n'));

const summaryTable = new Table({
  head: [
    chalk.cyan('Benchmark'),
    chalk.cyan('Status'),
    chalk.cyan('Threshold'),
  ],
  colWidths: [30, 15, 15],
});

for (const result of results) {
  summaryTable.push([
    result.name,
    result.status === 'passed' 
      ? chalk.green('✓ PASS') 
      : chalk.red('✗ FAIL'),
    `${result.threshold}x`,
  ]);
}

console.log(summaryTable.toString());

// Overall result
console.log(chalk.bold.cyan('\n' + '='.repeat(60) + '\n'));

if (allPassed) {
  console.log(chalk.bold.green('✅ ALL BENCHMARKS PASSED'));
  console.log(chalk.dim('Performance improvements validated successfully.\n'));
} else {
  console.log(chalk.bold.red('❌ SOME BENCHMARKS FAILED'));
  console.log(chalk.dim('Performance improvements below threshold.\n'));
}

// Save summary
const summary = {
  timestamp: new Date().toISOString(),
  results,
  allPassed,
  options,
};

writeFileSync(
  `${resultsDir}/benchmark-summary.json`,
  JSON.stringify(summary, null, 2)
);

console.log(chalk.dim(`Summary saved to: ${resultsDir}/benchmark-summary.json`));

// Generate HTML report if requested
if (options.html) {
  console.log(chalk.dim('\nGenerating HTML report...'));
  
  const html = generateHtmlReport(summary);
  const htmlPath = `${resultsDir}/benchmark-report.html`;
  writeFileSync(htmlPath, html);
  
  console.log(chalk.dim(`HTML report saved to: ${htmlPath}`));
}

// Compare with baseline if requested
if (options.compare && options.baseline) {
  console.log(chalk.dim(`\nComparing with baseline: ${options.baseline}`));
  
  try {
    const { readFileSync } = await import('fs');
    const baseline = JSON.parse(readFileSync(options.baseline, 'utf-8'));
    
    console.log('\nComparison:');
    for (const result of results) {
      const baselineResult = baseline.results.find(r => r.name === result.name);
      if (baselineResult) {
        const change = result.status === baselineResult.status ? 'no change' : 'changed';
        console.log(`  ${result.name}: ${change}`);
      }
    }
  } catch (error) {
    console.log(chalk.yellow('Could not load baseline for comparison'));
  }
}

// Exit with appropriate code
process.exit(allPassed ? 0 : 1);

function generateHtmlReport(summary) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mythos Benchmark Report</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .container {
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #ff6600;
      border-bottom: 3px solid #ff6600;
      padding-bottom: 10px;
    }
    h2 {
      color: #333;
      margin-top: 30px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }
    th {
      background: #f5f5f5;
      font-weight: bold;
    }
    .pass {
      color: #28a745;
      font-weight: bold;
    }
    .fail {
      color: #dc3545;
      font-weight: bold;
    }
    .summary {
      margin-top: 30px;
      padding: 20px;
      background: ${summary.allPassed ? '#d4edda' : '#f8d7da'};
      border-radius: 4px;
    }
    .meta {
      color: #666;
      font-size: 14px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🦞 Mythos Benchmark Report</h1>
    
    <div class="meta">
      <strong>Generated:</strong> ${summary.timestamp}<br>
      <strong>Status:</strong> ${summary.allPassed ? '✅ All Passed' : '❌ Some Failed'}
    </div>
    
    <h2>Results</h2>
    <table>
      <thead>
        <tr>
          <th>Benchmark</th>
          <th>Status</th>
          <th>Threshold</th>
        </tr>
      </thead>
      <tbody>
        ${summary.results.map(r => `
          <tr>
            <td>${r.name}</td>
            <td class="${r.status === 'passed' ? 'pass' : 'fail'}">
              ${r.status === 'passed' ? '✓ PASS' : '✗ FAIL'}
            </td>
            <td>${r.threshold}x</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    
    <div class="summary">
      <h2>Summary</h2>
      <p>
        ${summary.allPassed 
          ? '✅ All benchmarks passed successfully. Performance improvements validated.'
          : '❌ Some benchmarks failed. Performance improvements below threshold.'}
      </p>
      <p>
        <strong>Passed:</strong> ${summary.results.filter(r => r.status === 'passed').length} / ${summary.results.length}
      </p>
    </div>
  </div>
</body>
</html>`;
}
