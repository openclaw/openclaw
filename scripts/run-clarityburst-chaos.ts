#!/usr/bin/env node

/**
 * ClarityBurst Chaos Test Runner (Async with Concurrency Control)
 * 
 * Simulates real async execution of 10k+ agents with:
 * - Shared global concurrency limiter (promise pool)
 * - Queue depth tracking (agents waiting for router slot)
 * - Wait time metrics (p50/p95 queue wait)
 * - Starvation detection (wait > 5000ms)
 * 
 * Usage:
 *   tsx scripts/run-clarityburst-chaos.ts --agents 10000 --seed 42 --maxInFlight 200 --output compliance-artifacts/chaos
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import crypto from 'crypto';

interface ChaosConfig {
  agents: number;
  seed: number;
  scenarioMix: Map<string, number>;
  outputPath: string;
  maxInFlight: number;
}

interface RouteCall {
  agentId: string;
  stageId: string;
  scenario: string;
  ok: boolean;
  routingLatencyMs: number;
  queueWaitTimeMs: number;
  totalLatencyMs: number;
  timestamp: number;
}

interface ChaosMetrics {
  runId: string;
  timestamp: string;
  config: {
    agentsTotal: number;
    seed: number;
    scenarioMix: Record<string, number>;
    maxInFlight: number;
  };
  execution: {
    routerCallsTotal: number;
    executedOpsTotal: number;
    blockedOpsTotal: number;
    retriesTotal: number;
  };
  concurrency: {
    inFlightMaxObserved: number;
    queueDepthMaxObserved: number;
  };
  queueWaitTime: {
    p50Ms: number;
    p95Ms: number;
  };
  routingLatency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  totalLatency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  starvation: {
    count: number;
    threshold: number;
  };
  perStageCounts: Record<string, {
    routed: number;
    approved: number;
    denied: number;
  }>;
  scenarios: {
    approve: number;
    deny: number;
    ratelimit: number;
    authfail: number;
  };
}

/**
 * Simple promise-based concurrency limiter (semaphore)
 */
class ConcurrencyLimiter {
  private inFlight = 0;
  private queue: Array<() => void> = [];
  private inFlightMax = 0;
  private queueDepthMax = 0;

  constructor(private maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++;
      this.inFlightMax = Math.max(this.inFlightMax, this.inFlight);
      return;
    }

    // Queue is full, wait
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.inFlight++;
        this.inFlightMax = Math.max(this.inFlightMax, this.inFlight);
        resolve();
      });

      this.queueDepthMax = Math.max(this.queueDepthMax, this.queue.length);
    });
  }

  release(): void {
    this.inFlight--;

    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  getStats(): { inFlightMax: number; queueDepthMax: number } {
    return {
      inFlightMax: this.inFlightMax,
      queueDepthMax: this.queueDepthMax
    };
  }
}

/**
 * Deterministic seeded RNG
 */
class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }

  choice<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  range(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min));
  }
}

/**
 * Simulates async ClarityBurst routing decision
 * Includes random routing latency (1-50ms)
 */
async function simulateRoutingDecisionAsync(
  rng: SeededRandom,
  scenario: string,
  agentId: string
): Promise<Omit<RouteCall, 'queueWaitTimeMs' | 'totalLatencyMs' | 'timestamp'>> {
  const stages = [
    'TOOL_DISPATCH_GATE',
    'FILE_SYSTEM_OPS',
    'SHELL_EXEC',
    'NETWORK_IO',
    'MEMORY_MODIFY',
    'SUBAGENT_SPAWN',
    'MESSAGE_EMIT',
    'MEDIA_GENERATE',
    'BROWSER_AUTOMATE',
    'CANVAS_UI',
    'CRON_SCHEDULE',
    'NODE_INVOKE'
  ];

  const stageId = rng.choice(stages);
  const routingLatencyMs = rng.range(1, 50);

  // Simulate network latency
  await new Promise((resolve) => setTimeout(resolve, routingLatencyMs));

  let ok: boolean;
  switch (scenario) {
    case 'approve':
      ok = true;
      break;
    case 'deny':
      ok = rng.next() < 0.5;
      break;
    case 'ratelimit':
      ok = rng.next() < 0.7;
      break;
    case 'authfail':
      ok = rng.next() < 0.3;
      break;
    default:
      ok = true;
  }

  return {
    agentId,
    stageId,
    scenario,
    ok,
    routingLatencyMs
  };
}

/**
 * Parse CLI arguments
 */
function parseCLIArgs(): ChaosConfig {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    const value = args[i + 1];
    parsed[key] = value;
  }

  const agents = parseInt(parsed.agents || '10000');
  const seed = parseInt(parsed.seed || String(Date.now()));
  const outputPath = parsed.output || 'compliance-artifacts/chaos';
  const maxInFlight = parseInt(parsed.maxInFlight || '200');

  // Parse scenario mix (format: approve:50,deny:30,ratelimit:15,authfail:5)
  const scenarioMix = new Map<string, number>();
  const mixStr = parsed.scenarioMix || 'approve:50,deny:30,ratelimit:15,authfail:5';
  const parts = mixStr.split(',');
  for (const part of parts) {
    const [scenario, pct] = part.split(':');
    scenarioMix.set(scenario.trim(), parseInt(pct));
  }

  // Normalize percentages to sum to 100
  const total = Array.from(scenarioMix.values()).reduce((a, b) => a + b, 0);
  if (total !== 100) {
    console.warn(`Warning: scenario mix totals ${total}%, normalizing...`);
    scenarioMix.forEach((val, key) => {
      scenarioMix.set(key, Math.round((val / total) * 100));
    });
  }

  return {
    agents,
    seed,
    scenarioMix,
    outputPath,
    maxInFlight
  };
}

/**
 * Build weighted scenario list based on mix percentages
 */
function buildScenarioWeights(scenarioMix: Map<string, number>): string[] {
  const scenarios: string[] = [];
  for (const [scenario, pct] of scenarioMix.entries()) {
    for (let i = 0; i < pct; i++) {
      scenarios.push(scenario);
    }
  }
  return scenarios;
}

/**
 * Calculate percentile from sorted array
 */
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) {return 0;}
  const sorted = arr.toSorted((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Run chaos simulation with real async concurrency
 */
async function runChaos(config: ChaosConfig): Promise<void> {
  const runId = `chaos_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const rng = new SeededRandom(config.seed);
  const limiter = new ConcurrencyLimiter(config.maxInFlight);

  console.log(`[CHAOS] Starting async simulation: ${config.agents} agents, maxInFlight=${config.maxInFlight}, seed=${config.seed}`);
  console.log(`[CHAOS] Scenario mix:`, Object.fromEntries(config.scenarioMix));

  // Initialize metrics
  const routeCalls: RouteCall[] = [];
  const queueWaitTimes: number[] = [];
  const routingLatencies: number[] = [];
  const totalLatencies: number[] = [];
  const perStageCounts: Record<string, { routed: number; approved: number; denied: number }> = {};
  const scenarioCounts: Record<string, number> = {};
  let retriesTotal = 0;
  let starvationCount = 0;

  // Build weighted scenario list
  const scenarioWeights = buildScenarioWeights(config.scenarioMix);

  // Create array of agent tasks
  const agentTasks: Promise<void>[] = [];

  for (let agentIdx = 0; agentIdx < config.agents; agentIdx++) {
    const agentId = `agent_${agentIdx.toString().padStart(6, '0')}`;
    const scenario = scenarioWeights[agentIdx % scenarioWeights.length];

    // Each agent is an async task
    const agentTask = (async () => {
      const queueWaitStart = Date.now();

      // Request a slot in the concurrency limiter
      await limiter.acquire();

      const queueWaitEnd = Date.now();
      const queueWaitTimeMs = queueWaitEnd - queueWaitStart;

      try {
        const totalStart = Date.now();

        // Execute routing decision
        const result = await simulateRoutingDecisionAsync(rng, scenario, agentId);

        const totalEnd = Date.now();
        const totalLatencyMs = totalEnd - totalStart;

        // Record the call
        const call: RouteCall = {
          ...result,
          queueWaitTimeMs,
          totalLatencyMs,
          timestamp: totalEnd
        };

        routeCalls.push(call);
        queueWaitTimes.push(queueWaitTimeMs);
        routingLatencies.push(result.routingLatencyMs);
        totalLatencies.push(totalLatencyMs);

        // Track starvation (waited > 5000ms)
        if (queueWaitTimeMs > 5000) {
          starvationCount++;
        }

        // Track stage counts
        if (!perStageCounts[call.stageId]) {
          perStageCounts[call.stageId] = { routed: 0, approved: 0, denied: 0 };
        }
        perStageCounts[call.stageId].routed += 1;
        if (call.ok) {
          perStageCounts[call.stageId].approved += 1;
        } else {
          perStageCounts[call.stageId].denied += 1;
        }

        // Track scenario counts
        scenarioCounts[scenario] = (scenarioCounts[scenario] || 0) + 1;

        // Print progress every 1000 agents
        if (agentIdx % 1000 === 0 && agentIdx > 0) {
          console.log(`[CHAOS] Progress: ${agentIdx}/${config.agents} agents submitted`);
        }
      } finally {
        limiter.release();
      }
    })();

    agentTasks.push(agentTask);
  }

  console.log(`[CHAOS] All agents submitted, waiting for completion...`);

  // Wait for all agents to complete
  await Promise.all(agentTasks);

  console.log(`[CHAOS] Execution complete: ${routeCalls.length} agents routed`);

  // Calculate metrics
  const executedOps = routeCalls.filter((r) => r.ok).length;
  const blockedOps = routeCalls.filter((r) => !r.ok).length;
  const limiterStats = limiter.getStats();

  const metrics: ChaosMetrics = {
    runId,
    timestamp: new Date().toISOString(),
    config: {
      agentsTotal: config.agents,
      seed: config.seed,
      scenarioMix: Object.fromEntries(config.scenarioMix),
      maxInFlight: config.maxInFlight
    },
    execution: {
      routerCallsTotal: routeCalls.length,
      executedOpsTotal: executedOps,
      blockedOpsTotal: blockedOps,
      retriesTotal
    },
    concurrency: {
      inFlightMaxObserved: limiterStats.inFlightMax,
      queueDepthMaxObserved: limiterStats.queueDepthMax
    },
    queueWaitTime: {
      p50Ms: percentile(queueWaitTimes, 50),
      p95Ms: percentile(queueWaitTimes, 95)
    },
    routingLatency: {
      p50Ms: percentile(routingLatencies, 50),
      p95Ms: percentile(routingLatencies, 95),
      p99Ms: percentile(routingLatencies, 99),
      maxMs: Math.max(...routingLatencies)
    },
    totalLatency: {
      p50Ms: percentile(totalLatencies, 50),
      p95Ms: percentile(totalLatencies, 95),
      p99Ms: percentile(totalLatencies, 99),
      maxMs: Math.max(...totalLatencies)
    },
    starvation: {
      count: starvationCount,
      threshold: 5000
    },
    perStageCounts,
    scenarios: scenarioCounts as any
  };

  // Write output artifact
  mkdirSync(config.outputPath, { recursive: true });
  const outputFile = resolve(config.outputPath, `CHAOS_RUN_${runId}.json`);
  writeFileSync(outputFile, JSON.stringify(metrics, null, 2));

  console.log(`[CHAOS] Metrics written to: ${outputFile}`);

  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('CHAOS TEST SUMMARY (ASYNC WITH CONCURRENCY CONTROL)');
  console.log('='.repeat(80));
  console.log(`Run ID: ${runId}`);
  console.log(`Agents: ${config.agents}`);
  console.log(`Max In-Flight: ${config.maxInFlight}`);
  console.log(`\nRouter Calls: ${metrics.execution.routerCallsTotal}`);
  console.log(`Executed Ops: ${metrics.execution.executedOpsTotal} (${((metrics.execution.executedOpsTotal / metrics.execution.routerCallsTotal) * 100).toFixed(1)}%)`);
  console.log(`Blocked Ops: ${metrics.execution.blockedOpsTotal} (${((metrics.execution.blockedOpsTotal / metrics.execution.routerCallsTotal) * 100).toFixed(1)}%)`);
  
  console.log(`\nConcurrency Limits:`);
  console.log(`  Max In-Flight Observed: ${metrics.concurrency.inFlightMaxObserved}/${config.maxInFlight}`);
  console.log(`  Queue Depth (max): ${metrics.concurrency.queueDepthMaxObserved}`);

  console.log(`\nQueue Wait Time (time waiting for router slot):`);
  console.log(`  p50: ${metrics.queueWaitTime.p50Ms}ms`);
  console.log(`  p95: ${metrics.queueWaitTime.p95Ms}ms`);

  console.log(`\nRouting Latency (time inside router):`);
  console.log(`  p50: ${metrics.routingLatency.p50Ms}ms`);
  console.log(`  p95: ${metrics.routingLatency.p95Ms}ms`);
  console.log(`  p99: ${metrics.routingLatency.p99Ms}ms`);
  console.log(`  max: ${metrics.routingLatency.maxMs}ms`);

  console.log(`\nTotal Latency (queue + routing):`);
  console.log(`  p50: ${metrics.totalLatency.p50Ms}ms`);
  console.log(`  p95: ${metrics.totalLatency.p95Ms}ms`);
  console.log(`  p99: ${metrics.totalLatency.p99Ms}ms`);
  console.log(`  max: ${metrics.totalLatency.maxMs}ms`);

  console.log(`\nStarvation Detection:`);
  console.log(`  Agents waited > 5000ms: ${metrics.starvation.count} (${((metrics.starvation.count / config.agents) * 100).toFixed(2)}%)`);

  console.log(`\nScenarios:`);
  for (const [scenario, count] of Object.entries(metrics.scenarios)) {
    const pct = ((count / config.agents) * 100).toFixed(1);
    console.log(`  ${scenario}: ${count} (${pct}%)`);
  }

  console.log(`\nPer-Stage Routing:`);
  for (const [stage, counts] of Object.entries(metrics.perStageCounts).slice(0, 6)) {
    const approvalRate = ((counts.approved / counts.routed) * 100).toFixed(1);
    console.log(`  ${stage}: routed=${counts.routed}, approved=${counts.approved} (${approvalRate}%)`);
  }
  const remainingStages = Object.entries(metrics.perStageCounts).length - 6;
  if (remainingStages > 0) {
    console.log(`  ... and ${remainingStages} more stages`);
  }

  console.log('='.repeat(80));
}

// Main entry point
runChaos(parseCLIArgs()).catch((err) => {
  console.error('[CHAOS] Error:', err);
  process.exit(1);
});
