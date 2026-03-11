#!/usr/bin/env node

/**
 * ClarityBurst Chaos Test Runner - Phase 3: Fault Injection
 * 
 * Simulates real async execution with fault injection and recovery tracking:
 * - Router unavailability (simulates service down)
 * - Network partition (timeouts, temporary unavailability)
 * - Ontology pack corruption (malformed contract data)
 * - Agent crash mid-execution (restart/recovery)
 * - Cascading failures (fault propagation)
 * 
 * Usage:
 *   tsx scripts/run-clarityburst-chaos-phase3.ts --agents 10000 --seed 42 --maxInFlight 200 \
 *     --faultMode router-down --faultRate 10 --faultDuration 5000 --output compliance-artifacts/chaos
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import crypto from 'crypto';

type FaultMode = 'none' | 'router-down' | 'partition' | 'pack-corrupt' | 'agent-crash' | 'cascading';

interface ChaosConfig {
  agents: number;
  seed: number;
  scenarioMix: Map<string, number>;
  outputPath: string;
  maxInFlight: number;
  faultMode: FaultMode;
  faultRate: number; // Percentage of agents affected
  faultDuration: number; // Duration of fault in ms
}

interface FaultEvent {
  timestamp: number;
  type: FaultMode;
  agentId: string;
  duration: number;
  recovered: boolean;
  recoveryTimeMs: number;
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
  faultInjected?: string;
  retried?: boolean;
  recovered?: boolean;
}

interface ChaosMetrics {
  runId: string;
  timestamp: string;
  config: {
    agentsTotal: number;
    seed: number;
    scenarioMix: Record<string, number>;
    maxInFlight: number;
    faultMode: FaultMode;
    faultRate: number;
    faultDuration: number;
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
  faults: {
    injectedCount: number;
    recoveredCount: number;
    failedCount: number;
    recoveryTimeP50Ms: number;
    recoveryTimeP95Ms: number;
    cascadeDepthMax: number;
  };
  faultEvents: FaultEvent[];
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
 * Fault injection controller
 */
class FaultController {
  private faultStartTime: number | null = null;
  private faultActive = false;
  private affectedAgents = new Set<string>();
  private faultEvents: FaultEvent[] = [];
  private cascadeDepth = 0;

  constructor(
    private faultMode: FaultMode,
    private faultRate: number,
    private faultDuration: number,
    private seed: number
  ) {}

  startFault(currentTime: number): void {
    if (this.faultMode !== 'none') {
      this.faultStartTime = currentTime;
      this.faultActive = true;
      console.log(`[FAULT] ${this.faultMode} injected at ${currentTime}ms, duration: ${this.faultDuration}ms`);
    }
  }

  shouldInjectFault(agentId: string, rng: SeededRandom, currentTime: number): boolean {
    if (this.faultMode === 'none' || !this.faultStartTime) {
      return false;
    }

    // Check if fault window is active
    const elapsed = currentTime - this.faultStartTime;
    if (elapsed < 0 || elapsed > this.faultDuration) {
      if (this.faultActive && elapsed > this.faultDuration) {
        this.faultActive = false;
        console.log(`[FAULT] ${this.faultMode} resolved at ${currentTime}ms`);
      }
      return false;
    }

    // Determine if this agent is affected (deterministic based on seed)
    const agentHash = (parseInt(agentId.split('_')[1]) + this.seed) % 100;
    const affected = agentHash < this.faultRate;

    if (affected && this.faultMode === 'cascading' && this.affectedAgents.size > 0) {
      // Cascading: more likely if others are already affected
      const cascadeChance = Math.min(50, 10 + this.affectedAgents.size);
      return rng.next() * 100 < cascadeChance;
    }

    return affected;
  }

  recordFault(agentId: string, faultType: string, recoveryTimeMs: number): void {
    this.affectedAgents.add(agentId);
    this.cascadeDepth = Math.max(this.cascadeDepth, this.affectedAgents.size);

    this.faultEvents.push({
      timestamp: Date.now(),
      type: this.faultMode,
      agentId,
      duration: this.faultDuration,
      recovered: recoveryTimeMs > 0,
      recoveryTimeMs
    });
  }

  getStats(): {
    injectedCount: number;
    recoveredCount: number;
    recoveryTimes: number[];
    cascadeDepthMax: number;
  } {
    const recoveredEvents = this.faultEvents.filter(e => e.recovered);
    return {
      injectedCount: this.faultEvents.length,
      recoveredCount: recoveredEvents.length,
      recoveryTimes: recoveredEvents.map(e => e.recoveryTimeMs),
      cascadeDepthMax: this.cascadeDepth
    };
  }

  getFaultEvents(): FaultEvent[] {
    return this.faultEvents;
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
 * Simulates async ClarityBurst routing decision with fault injection
 */
async function simulateRoutingDecisionAsync(
  rng: SeededRandom,
  scenario: string,
  agentId: string,
  faultController: FaultController,
  startTime: number
): Promise<Omit<RouteCall, 'queueWaitTimeMs' | 'totalLatencyMs' | 'timestamp'> & { faultInjected?: string; retried?: boolean; recovered?: boolean }> {
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
  let recovered = false;

  // Check for fault injection
  const now = Date.now();
  let faultInjected: string | undefined;

  if (faultController.shouldInjectFault(agentId, rng, now - startTime)) {
    faultInjected = 'injected';

    switch (faultController['faultMode'] || 'none') {
      case 'router-down':
        // Simulate router unavailable
        await new Promise((resolve) => setTimeout(resolve, 100));
        break;

      case 'partition':
        // Simulate network timeout
        await new Promise((resolve) => setTimeout(resolve, 5000));
        break;

      case 'pack-corrupt':
        // Simulate corrupted pack (try again with fresh data)
        await new Promise((resolve) => setTimeout(resolve, 200));
        recovered = true;
        break;

      case 'agent-crash':
        // Simulate agent restart
        await new Promise((resolve) => setTimeout(resolve, 1000));
        recovered = true;
        break;

      case 'cascading':
        // Cascade effect (retry with delay)
        await new Promise((resolve) => setTimeout(resolve, 500));
        recovered = rng.next() > 0.3; // 70% recovery rate
        break;

      default:
        break;
    }

    faultController.recordFault(agentId, faultInjected, recovered ? 500 : 0);
  }

  // Normal routing latency
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

  // Faults can cause denials
  if (faultInjected && !recovered) {
    ok = false;
  }

  return {
    agentId,
    stageId,
    scenario,
    ok,
    routingLatencyMs: routingLatencyMs + (faultInjected ? 100 : 0),
    faultInjected,
    recovered
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
  const faultMode = (parsed.faultMode || 'none') as FaultMode;
  const faultRate = parseInt(parsed.faultRate || '10'); // 10% of agents affected
  const faultDuration = parseInt(parsed.faultDuration || '5000'); // 5 seconds

  // Parse scenario mix
  const scenarioMix = new Map<string, number>();
  const mixStr = parsed.scenarioMix || 'approve:50,deny:30,ratelimit:15,authfail:5';
  const parts = mixStr.split(',');
  for (const part of parts) {
    const [scenario, pct] = part.split(':');
    scenarioMix.set(scenario.trim(), parseInt(pct));
  }

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
    maxInFlight,
    faultMode,
    faultRate,
    faultDuration
  };
}

/**
 * Build weighted scenario list
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
 * Run chaos simulation with fault injection
 */
async function runChaos(config: ChaosConfig): Promise<void> {
  const runId = `chaos_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const rng = new SeededRandom(config.seed);
  const limiter = new ConcurrencyLimiter(config.maxInFlight);
  const faultController = new FaultController(config.faultMode, config.faultRate, config.faultDuration, config.seed);

  console.log(`[CHAOS] Starting Phase 3 with fault injection: ${config.agents} agents`);
  console.log(`[CHAOS] maxInFlight=${config.maxInFlight}, faultMode=${config.faultMode}`);
  if (config.faultMode !== 'none') {
    console.log(`[CHAOS] faultRate=${config.faultRate}%, faultDuration=${config.faultDuration}ms`);
  }

  // Initialize metrics
  const routeCalls: RouteCall[] = [];
  const queueWaitTimes: number[] = [];
  const routingLatencies: number[] = [];
  const totalLatencies: number[] = [];
  const perStageCounts: Record<string, { routed: number; approved: number; denied: number }> = {};
  const scenarioCounts: Record<string, number> = {};
  let retriesTotal = 0;
  let starvationCount = 0;

  // Build scenario weights
  const scenarioWeights = buildScenarioWeights(config.scenarioMix);

  // Trigger fault halfway through execution
  const faultTriggerTime = Math.ceil((config.agents * 50) / config.maxInFlight); // Rough estimate

  // Create agent tasks
  const agentTasks: Promise<void>[] = [];
  const startTime = Date.now();
  let tasksCreated = 0;

  for (let agentIdx = 0; agentIdx < config.agents; agentIdx++) {
    const agentId = `agent_${agentIdx.toString().padStart(6, '0')}`;
    const scenario = scenarioWeights[agentIdx % scenarioWeights.length];

    // Trigger fault halfway through
    if (agentIdx === Math.floor(config.agents / 2) && config.faultMode !== 'none') {
      faultController.startFault(Date.now() - startTime);
    }

    const agentTask = (async () => {
      const queueWaitStart = Date.now();

      await limiter.acquire();

      const queueWaitEnd = Date.now();
      const queueWaitTimeMs = queueWaitEnd - queueWaitStart;

      try {
        const totalStart = Date.now();

        // Execute routing decision with fault injection
        const result = await simulateRoutingDecisionAsync(
          rng,
          scenario,
          agentId,
          faultController,
          startTime
        );

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

        // Track starvation
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

        // Progress log
        if (agentIdx % 2000 === 0 && agentIdx > 0) {
          const elapsed = Date.now() - startTime;
          console.log(`[CHAOS] Progress: ${agentIdx}/${config.agents} agents (${elapsed}ms elapsed)`);
        }
      } finally {
        limiter.release();
      }
    })();

    agentTasks.push(agentTask);
    tasksCreated++;
  }

  console.log(`[CHAOS] All ${tasksCreated} agents submitted, waiting for completion...`);

  // Wait for all agents
  await Promise.all(agentTasks);

  console.log(`[CHAOS] Execution complete: ${routeCalls.length} agents routed`);

  // Calculate metrics
  const executedOps = routeCalls.filter((r) => r.ok).length;
  const blockedOps = routeCalls.filter((r) => !r.ok).length;
  const limiterStats = limiter.getStats();
  const faultStats = faultController.getStats();

  const metrics: ChaosMetrics = {
    runId,
    timestamp: new Date().toISOString(),
    config: {
      agentsTotal: config.agents,
      seed: config.seed,
      scenarioMix: Object.fromEntries(config.scenarioMix),
      maxInFlight: config.maxInFlight,
      faultMode: config.faultMode,
      faultRate: config.faultRate,
      faultDuration: config.faultDuration
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
    faults: {
      injectedCount: faultStats.injectedCount,
      recoveredCount: faultStats.recoveredCount,
      failedCount: faultStats.injectedCount - faultStats.recoveredCount,
      recoveryTimeP50Ms: percentile(faultStats.recoveryTimes, 50),
      recoveryTimeP95Ms: percentile(faultStats.recoveryTimes, 95),
      cascadeDepthMax: faultStats.cascadeDepthMax
    },
    faultEvents: faultController.getFaultEvents(),
    perStageCounts,
    scenarios: scenarioCounts as any
  };

  // Write output
  mkdirSync(config.outputPath, { recursive: true });
  const outputFile = resolve(config.outputPath, `CHAOS_RUN_${runId}.json`);
  writeFileSync(outputFile, JSON.stringify(metrics, null, 2));

  console.log(`[CHAOS] Metrics written to: ${outputFile}`);

  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('CHAOS TEST SUMMARY - PHASE 3 (FAULT INJECTION)');
  console.log('='.repeat(80));
  console.log(`Run ID: ${runId}`);
  console.log(`Agents: ${config.agents}`);
  console.log(`Max In-Flight: ${config.maxInFlight}`);
  console.log(`Fault Mode: ${config.faultMode}`);

  if (config.faultMode !== 'none') {
    console.log(`\nFault Injection Results:`);
    console.log(`  Faults Injected: ${metrics.faults.injectedCount}`);
    console.log(`  Recovered: ${metrics.faults.recoveredCount}`);
    console.log(`  Failed: ${metrics.faults.failedCount}`);
    console.log(`  Recovery Time p50: ${metrics.faults.recoveryTimeP50Ms}ms`);
    console.log(`  Recovery Time p95: ${metrics.faults.recoveryTimeP95Ms}ms`);
    console.log(`  Cascade Depth (max): ${metrics.faults.cascadeDepthMax}`);
  }

  console.log(`\nRouter Calls: ${metrics.execution.routerCallsTotal}`);
  console.log(`Executed Ops: ${metrics.execution.executedOpsTotal} (${((metrics.execution.executedOpsTotal / metrics.execution.routerCallsTotal) * 100).toFixed(1)}%)`);
  console.log(`Blocked Ops: ${metrics.execution.blockedOpsTotal} (${((metrics.execution.blockedOpsTotal / metrics.execution.routerCallsTotal) * 100).toFixed(1)}%)`);

  console.log(`\nConcurrency:`);
  console.log(`  Max In-Flight Observed: ${metrics.concurrency.inFlightMaxObserved}/${config.maxInFlight}`);
  console.log(`  Queue Depth (max): ${metrics.concurrency.queueDepthMaxObserved}`);

  console.log(`\nQueue Wait Time:`);
  console.log(`  p50: ${metrics.queueWaitTime.p50Ms}ms`);
  console.log(`  p95: ${metrics.queueWaitTime.p95Ms}ms`);

  console.log(`\nTotal Latency (with faults):`);
  console.log(`  p50: ${metrics.totalLatency.p50Ms}ms`);
  console.log(`  p95: ${metrics.totalLatency.p95Ms}ms`);
  console.log(`  p99: ${metrics.totalLatency.p99Ms}ms`);
  console.log(`  max: ${metrics.totalLatency.maxMs}ms`);

  console.log(`\nStarvation:`);
  console.log(`  Agents waited > 5000ms: ${metrics.starvation.count} (${((metrics.starvation.count / config.agents) * 100).toFixed(2)}%)`);

  console.log('='.repeat(80));
}

// Main entry point
runChaos(parseCLIArgs()).catch((err) => {
  console.error('[CHAOS] Error:', err);
  process.exit(1);
});
