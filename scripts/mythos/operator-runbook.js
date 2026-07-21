#!/usr/bin/env node
/**
 * Mythos-Class Operator Runbook Script
 * Comprehensive operational commands for managing Mythos deployments
 *
 * Usage:
 *   node scripts/mythos/operator-runbook.js <command> [options]
 *
 * Commands:
 *   check           - Run all health checks
 *   engines         - Check native engine status
 *   memory          - Memory system health
 *   fleet           - Fleet agent status
 *   security        - Security audit
 *   backup          - Create backup
 *   restore         - Restore from backup
 *   rotate-token    - Rotate gateway token
 *   diagnose        - Run diagnostics
 *   benchmark       - Run performance benchmarks
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || process.env.HOME;
const OPENCLAW_DIR = join(OPENCLAW_HOME, '.openclaw');
const MYTHOS_DIR = join(OPENCLAW_DIR, 'mythos');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[0;33m',
  blue: '\x1b[0;34m',
  cyan: '\x1b[0;36m',
  bold: '\x1b[1m',
};

function log(color, message) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(colors.green, `✓ ${message}`);
}

function logWarning(message) {
  log(colors.yellow, `⚠ ${message}`);
}

function logError(message) {
  log(colors.red, `✗ ${message}`);
}

function logInfo(message) {
  log(colors.cyan, `ℹ ${message}`);
}

function logHeader(message) {
  log(colors.bold, `\n${'='.repeat(60)}\n${message}\n${'='.repeat(60)}\n`);
}

// ─── Health Check Commands ─────────────────────────────────────────────────────

async function checkAll() {
  logHeader('Mythos-Class Health Check');

  await checkGateway();
  await checkEngines();
  await checkMemory();
  await checkFleet();
  await checkSecurity();

  logHeader('Health Check Complete');
}

async function checkGateway() {
  log('\n🦞 Gateway Status');

  try {
    const result = execSync('openclaw status', { encoding: 'utf-8' });
    logSuccess('Gateway is running');
    console.log(result);
  } catch (error) {
    logError('Gateway is not running');
    logInfo('Start with: openclaw gateway start');
  }
}

async function checkEngines() {
  log('\n🦀 Native Engine Status');

  try {
    const result = execSync('openclaw doctor --deep', { encoding: 'utf-8' });

    const engines = [
      'mythos-vector-engine',
      'mythos-search-engine',
      'mythos-embedding-runtime',
      'mythos-execution-sandbox',
      'mythos-protocol-codec',
      'mythos-causal-graph',
    ];

    for (const engine of engines) {
      if (result.includes(engine)) {
        logSuccess(`${engine} loaded`);
      } else {
        logWarning(`${engine} not available (using fallback)`);
      }
    }
  } catch (error) {
    logError('Failed to check engines');
  }
}

async function checkMemory() {
  log('\n🧠 Memory System Status');

  try {
    const result = execSync('openclaw memory status', { encoding: 'utf-8' });
    console.log(result);
  } catch (error) {
    logError('Failed to check memory status');
  }
}

async function checkFleet() {
  log('\n🏛️ Fleet Agent Status');

  const agents = ['PRIME', 'RESEARCH', 'CODE', 'OPS', 'MEMORY', 'CRITIC'];

  for (const agent of agents) {
    const agentDir = join(MYTHOS_DIR, 'fleet', agent);
    if (existsSync(agentDir)) {
      logSuccess(`${agent} workspace exists`);
    } else {
      logWarning(`${agent} workspace missing`);
    }
  }
}

async function checkSecurity() {
  log('\n🔒 Security Status');

  try {
    const result = execSync('openclaw security audit', { encoding: 'utf-8' });
    console.log(result);
  } catch (error) {
    logError('Security audit failed');
  }
}

// ─── Memory Operations ─────────────────────────────────────────────────────────

async function memoryStatus() {
  logHeader('Memory System Status');

  try {
    execSync('openclaw memory status', { stdio: 'inherit' });
  } catch (error) {
    logError('Failed to get memory status');
  }
}

async function memoryRebuild() {
  logHeader('Rebuilding Memory Index');

  try {
    execSync('openclaw memory rebuild', { stdio: 'inherit' });
    logSuccess('Memory index rebuilt');
  } catch (error) {
    logError('Failed to rebuild memory index');
  }
}

async function memorySearch(query) {
  logHeader(`Searching Memory: "${query}"`);

  try {
    execSync(`openclaw memory search "${query}"`, { stdio: 'inherit' });
  } catch (error) {
    logError('Search failed');
  }
}

// ─── Fleet Operations ──────────────────────────────────────────────────────────

async function fleetStatus() {
  logHeader('Fleet Agent Status');

  const agents = ['PRIME', 'RESEARCH', 'CODE', 'OPS', 'MEMORY', 'CRITIC'];

  for (const agent of agents) {
    log(`\n${agent}:`);

    const soulPath = join(MYTHOS_DIR, 'fleet', agent, 'SOUL.md');
    const agentsPath = join(MYTHOS_DIR, 'fleet', agent, 'AGENTS.md');
    const memoryPath = join(MYTHOS_DIR, 'fleet', agent, 'memory');

    if (existsSync(soulPath)) {
      logSuccess('SOUL.md exists');
    } else {
      logWarning('SOUL.md missing');
    }

    if (existsSync(agentsPath)) {
      logSuccess('AGENTS.md exists');
    } else {
      logWarning('AGENTS.md missing');
    }

    if (existsSync(memoryPath)) {
      logSuccess('memory/ directory exists');
    } else {
      logWarning('memory/ directory missing');
    }
  }
}

async function fleetSpawn(agent, task) {
  logHeader(`Spawning ${agent} Agent`);

  try {
    const cmd = `openclaw acp spawn --agent ${agent.toLowerCase()} --task "${task}"`;
    execSync(cmd, { stdio: 'inherit' });
    logSuccess(`${agent} agent spawned`);
  } catch (error) {
    logError(`Failed to spawn ${agent} agent`);
  }
}

// ─── Backup & Restore ──────────────────────────────────────────────────────────

async function backup() {
  logHeader('Creating Backup');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(MYTHOS_DIR, 'backups');
  const backupPath = join(backupDir, `mythos-backup-${timestamp}.tar.gz`);

  mkdirSync(backupDir, { recursive: true });

  try {
    execSync(
      `tar -czf ${backupPath} -C ${OPENCLAW_DIR} .openclaw mythos-workspace`,
      { stdio: 'inherit' }
    );
    logSuccess(`Backup created: ${backupPath}`);
  } catch (error) {
    logError('Backup failed');
  }
}

async function restore(backupPath) {
  logHeader('Restoring from Backup');

  if (!existsSync(backupPath)) {
    logError(`Backup file not found: ${backupPath}`);
    return;
  }

  try {
    execSync(`tar -xzf ${backupPath} -C ${OPENCLAW_HOME}`, {
      stdio: 'inherit',
    });
    logSuccess('Restore complete');
    logInfo('Restart gateway to apply changes: openclaw gateway restart');
  } catch (error) {
    logError('Restore failed');
  }
}

// ─── Security Operations ───────────────────────────────────────────────────────

async function rotateToken() {
  logHeader('Rotating Gateway Token');

  try {
    execSync('openclaw secrets rotate-token', { stdio: 'inherit' });
    logSuccess('Token rotated');
    logInfo('Restart gateway: openclaw gateway restart');
    logInfo('Update .env file with new token');
  } catch (error) {
    logError('Token rotation failed');
  }
}

async function auditPolicies() {
  logHeader('Auditing Security Policies');

  const policyDir = join(MYTHOS_DIR, 'nemoclaw', 'policies');

  if (!existsSync(policyDir)) {
    logWarning('No NemoClaw policies found');
    return;
  }

  const agents = ['prime', 'research', 'code', 'ops', 'memory', 'critic'];

  for (const agent of agents) {
    const policyPath = join(policyDir, `${agent}.yaml`);
    if (existsSync(policyPath)) {
      logSuccess(`${agent}.yaml exists`);
    } else {
      logWarning(`${agent}.yaml missing`);
    }
  }
}

// ─── Diagnostics ───────────────────────────────────────────────────────────────

async function diagnose() {
  logHeader('Running Diagnostics');

  try {
    execSync('openclaw doctor --deep', { stdio: 'inherit' });
  } catch (error) {
    logError('Diagnostics failed');
  }
}

// ─── Benchmark ─────────────────────────────────────────────────────────────────

async function benchmark() {
  logHeader('Running Performance Benchmarks');

  log('\n📊 Vector Search Benchmark');

  // Create test vectors
  const testVectors = [];
  for (let i = 0; i < 1000; i++) {
    testVectors.push({
      id: `test-${i}`,
      vector: [Math.random(), Math.random(), Math.random()],
      path: `/test/${i}.md`,
      startLine: 1,
      endLine: 10,
    });
  }

  const startTime = Date.now();

  try {
    // Benchmark would go here
    // This is a placeholder for actual benchmarking code
    logSuccess('Benchmark placeholder - implement actual benchmarks');
  } catch (error) {
    logError('Benchmark failed');
  }

  const elapsed = Date.now() - startTime;
  logInfo(`Benchmark completed in ${elapsed}ms`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const commands = {
  check: checkAll,
  engines: checkEngines,
  memory: memoryStatus,
  'memory:rebuild': memoryRebuild,
  'memory:search': memorySearch,
  fleet: fleetStatus,
  'fleet:spawn': fleetSpawn,
  backup,
  restore,
  'rotate-token': rotateToken,
  'audit-policies': auditPolicies,
  diagnose,
  benchmark,
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const params = args.slice(1);

  if (!command || command === 'help') {
    console.log(`
Mythos-Class Operator Runbook

Commands:
  check              Run all health checks
  engines            Check native engine status
  memory             Memory system health
  memory:rebuild     Rebuild memory index
  memory:search <q>  Search memory
  fleet              Fleet agent status
  fleet:spawn <a> <t> Spawn agent with task
  backup             Create backup
  restore <path>     Restore from backup
  rotate-token       Rotate gateway token
  audit-policies     Audit security policies
  diagnose           Run diagnostics
  benchmark          Run benchmarks
  help               Show this help

Examples:
  node operator-runbook.js check
  node operator-runbook.js memory:search "vector search"
  node operator-runbook.js fleet:spawn RESEARCH "Find Rust tutorials"
  node operator-runbook.js backup
  node operator-runbook.js restore /path/to/backup.tar.gz
`);
    return;
  }

  const handler = commands[command];

  if (!handler) {
    logError(`Unknown command: ${command}`);
    logInfo('Run with "help" to see available commands');
    process.exit(1);
  }

  try {
    await handler(...params);
  } catch (error) {
    logError(`Command failed: ${error.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
