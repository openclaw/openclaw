#!/usr/bin/env node

const fs = require('fs');
const { buildQuoteIntake } = require('./index');

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--file') {
      options.file = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

async function loadRequest(options) {
  if (options.file) {
    return JSON.parse(fs.readFileSync(options.file, 'utf8'));
  }
  if (options.json) {
    return JSON.parse(options.json);
  }
  if (!process.stdin.isTTY) {
    const stdin = await readStdin();
    if (stdin.trim()) return JSON.parse(stdin);
  }
  throw new Error('Provide request JSON with --json, --file, or stdin.');
}

async function main() {
  const request = await loadRequest(parseArgs(process.argv.slice(2)));
  const result = await buildQuoteIntake(request);
  process.stdout.write(JSON.stringify(result, null, 2));
  process.stdout.write('\n');
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
