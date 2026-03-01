---
title: "Gateway Simulation Harness"
type: feat
date: 2026-02-26
deepened: 2026-03-01
---

# Gateway Simulation Harness

## Enhancement Summary

**Deepened on:** 2026-02-26
**Sections enhanced:** 12
**Agents used:** 15 (Architecture Strategist, Performance Oracle, Security Sentinel, TypeScript Reviewer, Race Condition Reviewer, Code Simplicity Reviewer, Pattern Recognition Specialist, Agent-Native Reviewer, Agent-Native Architecture, Best Practices Researcher, Diagnostic Event Explorer, Agent Runner Explorer, Swarm Orchestration, Learnings Researcher, Framework Docs Researcher)

### Critical Fixes (Must Address Before Implementation)

1. **`streamFnOverride` injection point** — Plan says "No changes to run.ts" but the fake provider CANNOT be injected without Vitest module mocking. Add `streamFnOverride?: StreamFn` to `RunEmbeddedPiAgentParams` and use it in `attempt.ts:871`.
2. **`resetAllLanes()` is destructive** — Using it in abort path would destroy ALL lane state. Use `sim:{runId}:` lane prefixes and a new `resetLanesByPrefix(prefix)` function instead.
3. **YAML package** — Plan references `js-yaml` but codebase uses the `yaml` (eemeli) package v2.8.2. `js-yaml` has CVE-2025-64718 (prototype pollution via merge key). Use `import YAML from "yaml"` with `{ schema: "core", strict: true, uniqueKeys: true }`.
4. **Fake channel incomplete** — Plan's fake channel omits required `ChannelMeta` fields (`selectionLabel`, `blurb`, `id`). Use `createChannelTestPluginBase()` from `src/test-utils/channel-plugins.ts` as composition base.
5. **Diagnostic events must go through logging layer** — New events should emit via `src/logging/diagnostic.ts` (e.g., `logLaneTaskComplete`), not directly from `command-queue.ts`, matching the established pattern.

### Key Improvements Discovered

- **API-first design**: Export `runSimulation()` as the primary API, CLI as thin wrapper — enables agent access, CI integration, and future web dashboard without code duplication.
- **Seeded PRNG for reproducibility**: Replace `Math.random()` with a seeded PRNG (e.g., mulberry32) for deterministic error injection and random traffic.
- **MessageTracker indexes**: Add `byId` Map and `byConversation` Map for O(1) lookups instead of linear scans.
- **AbortController for cancellation**: Thread `AbortSignal` through fake provider and runner for clean teardown.
- **Discriminated union types**: Use tagged unions for `SimMessage` (inbound vs outbound) and `SimSymptom` variants instead of optional fields.
- **EWMA-based lag drift detection**: Use Exponentially Weighted Moving Average for O(1) streaming detection instead of O(n) linear regression.

## Overview

A simulation tool that wraps a real OpenClaw gateway with fake channels and fake LLM providers, providing complete visibility into queue dynamics, lane behavior, and message causality. The primary use case is reproducing and diagnosing production pathologies: reply explosions, event-horizon lag drift, queue backlog growth, and out-of-sync multi-agent conversations.

Every message in the simulation carries a UUIDv7 identifier and a causal reference (the ID + timestamp of the most recent message the agent processed when producing its reply), creating a traceable causal graph of the entire conversation flow.

Phase 1 is a CLI tool. Phase 2 adds a web-based live dashboard.

### Research Insights — Overview

**Agent-Native Architecture:**

- Export `runSimulation(scenario: ScenarioConfig, opts?: SimulationOpts): Promise<SimReport>` as the primary programmatic API. The CLI and web dashboard are both thin wrappers.
- Return a `LiveSimulationHandle` for in-progress simulations: `{ abort(): void; onEvent(listener): unsubscribe; report: Promise<SimReport>; suggestedActions: SimAction[] }`.
- Barrel export at `src/simulation/index.ts` — agents and scripts should be able to `import { runSimulation } from "../simulation/index.js"`.
- Provide `deriveScenario(base, overrides)` and `parameterSweep(base, axis, values)` utilities for programmatic scenario generation.

**Simplification Considerations (Code Simplicity Reviewer):**

- Implementation order within Phase 1: start with reply explosion + stale context + queue backlog detectors, then add lag drift and out-of-sync once the core pipeline works.
- Traffic patterns: implement `burst` and `steady` first, then `random` and `replay`.
- Live terminal dashboard: implement `--verbose` streaming first (quick win), then layer the full ANSI TUI on top.

## Problem Statement

Production issues like reply explosions and lag drift are difficult to reproduce because they emerge from the interaction of multiple agents, multiple conversations, queue concurrency settings, and channel delivery latency. Today there is no way to:

- Replay traffic patterns against the real gateway code with controlled timing
- Observe queue state evolution across all lanes simultaneously
- Trace exactly what context each agent saw when it produced a reply
- Compare configurations (e.g., maxConcurrent=1 vs 3, with/without drain delay)
- Generate reproducible evidence of pathological behavior

## Proposed Solution

### Architecture

```
+------------------+     +-------------------+     +------------------+
|  Scenario Engine |---->|  Fake Channels    |---->|                  |
|  (traffic gen)   |     |  (inbound/outbound|     |  Real Gateway    |
+------------------+     |   with UUIDv7     |     |  (lanes, queue,  |
                         |   tracking)       |     |   agent runner)  |
+------------------+     +-------------------+     |                  |
|  Fake LLM        |<-----------------------------|                  |
|  Provider         |     +-------------------+     +------------------+
|  (scripted resp, |     |  Queue Monitor    |
|   config latency)|     |  (diagnostic evts |
+------------------+     |   + lane snapshots)|
                         +-------------------+
                               |
                         +-------------------+
                         |  Symptom Detector |
                         |  + Report Writer  |
                         +-------------------+
                               |
                    +----------+----------+
                    |                     |
              CLI Dashboard        Web Dashboard
              (Phase 1)            (Phase 2)
```

### Research Insights — Architecture

**Architecture Strategist — Critical Injection Points:**

- The `streamFnOverride` parameter is the lynchpin. Without it, the fake provider cannot be injected without Vitest module-level mocking. Add to `RunEmbeddedPiAgentParams`:

  ```typescript
  streamFnOverride?: StreamFn;
  ```

  And in `src/agents/pi-embedded-runner/run/attempt.ts:871`:

  ```typescript
  activeSession.agent.streamFn = params.streamFnOverride ?? streamSimple;
  ```

- The existing `enqueue` param override in `RunEmbeddedPiAgentParams` provides the queue injection point — no additional changes needed there.
- Auth profiles can be faked via config injection: provide a mock agent config with `providers.fake.auth: [{ type: "key", key: "sim-key" }]`. The auth profile selector will use it without additional mocking.

**Pipeline Nature (Swarm Orchestration):**

- The simulation is fundamentally a pipeline, not a swarm: `load scenario -> wire fakes -> generate traffic -> monitor -> detect -> report`. Keep this sequential. Swarm/parallel patterns are not applicable to the core simulation flow.
- Swarm patterns ARE useful for the development workflow: run multiple review agents in parallel during code review of the simulation code.

**Institutional Learning (Per-Channel Config Cascade):**

- When the simulation injects config for `maxConcurrentPerConversation` or `conversationLaneDrainDelayMs`, it must provide a config object that matches the cascade resolver's expected shape (`cfg.channels?.discord` typed as `DiscordConfig`, etc.). The fake channel type must have a corresponding entry in the config cascade.
- `peerId` prefix stripping (`indexOf(":")` not `lastIndexOf(":")`) applies to any simulation scenario that references conversations by peer ID.

### Core Components

#### 1. Scenario Definition (`src/simulation/scenario.ts`)

YAML-based scenario files define the simulation parameters:

```yaml
name: reply-explosion-under-burst
description: >
  10 messages hit the same group conversation in 500ms.
  Model takes 2s to respond. What happens?

agents:
  - id: agent-1
    provider: fake
    model: fake-slow

channels:
  - type: telegram
    accounts:
      - id: bot1

conversations:
  - id: conv-1
    channel: telegram
    account: bot1
    peer: group-42
    chatType: group

providers:
  fake:
    models:
      fake-slow:
        latencyMs: 2000
        response: "I'm agent {agentId} responding to message {messageId}"
      fake-fast:
        latencyMs: 200
        response: "Quick reply from {agentId}"
      fake-error:
        latencyMs: 500
        errorRate: 0.3
        response: "ok"

traffic:
  - conversation: conv-1
    pattern: burst # burst | steady | random | replay
    count: 10
    intervalMs: 50
    startAtMs: 0
    senderIds:
      - user-1
      - user-2
      - user-3

config:
  agents:
    defaults:
      maxConcurrent: 3
      # maxConcurrentPerConversation: 1   (when feature lands)
      # conversationLaneDrainDelayMs: 500 (when feature lands)

monitor:
  sampleIntervalMs: 100
  captureEvents:
    - queue.lane.enqueue
    - queue.lane.dequeue
    - session.state
    - message.queued
    - message.processed
    - run.attempt

symptoms:
  reply_explosion:
    maxRatio: 1.5
    windowMs: 10000
  lag_drift:
    maxSlopeMs: 200
    windowMessages: 10
  queue_backlog:
    maxDepth: 20
    sustainedGrowthSamples: 5
  stale_context:
    maxStaleness: 3
  out_of_sync:
    enabled: true

assertions:
  - type: max_queue_depth
    lane: "session:*"
    threshold: 5
  - type: max_reply_latency_ms
    threshold: 10000
  - type: no_reply_explosion
    maxRepliesPerMessage: 2
```

### Research Insights — Scenario Definition

**Best Practices Researcher:**

- Use a **seeded PRNG** for reproducibility. Add `seed?: number` to scenario config. When set, all random decisions (error injection, random traffic patterns, sender selection) use a deterministic generator. Example: mulberry32 (fast, 32-bit, seedable).

  ```typescript
  function mulberry32(seed: number) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  ```

- Add `seed` to scenario YAML (`seed: 42`). Report output includes the seed used so any run can be reproduced.

**Security Sentinel:**

- Use `import YAML from "yaml"` (eemeli) with strict parsing: `YAML.parse(content, { schema: "core", strict: true, uniqueKeys: true })`. The `core` schema disables the YAML merge key (`<<:`) which is the attack vector for CVE-2025-64718 in `js-yaml`.
- Validate parsed YAML against Zod schema immediately. Never pass unvalidated YAML objects to business logic.

**Implementation order:**

- Implement `burst` and `steady` first (simplest), then `random` (Poisson distribution with seeded PRNG), then `replay` (production log parsing). All are Phase 1 scope.
- Assertions are included in Phase 1 — they enable CI integration (pass/fail on scenario runs).

**Traffic patterns:**

- `burst`: N messages in rapid succession (intervalMs between each)
- `steady`: Constant rate over a duration
- `random`: Poisson-distributed arrivals with configurable lambda (uses seeded PRNG)
- `replay`: Replay a recorded production traffic log (timestamps from file)

#### 2. Message Tracker (`src/simulation/message-tracker.ts`)

Every message gets a UUIDv7 and causal metadata:

```typescript
import { uuidv7 } from "./uuidv7.js";

/** Discriminated union for simulation messages. */
export type SimMessage = SimInboundMessage | SimOutboundMessage;

interface SimMessageBase {
  /** UUIDv7 — timestamp-sortable unique ID. */
  id: string;
  /** Unix timestamp (ms) when this message was created. */
  ts: number;
  /** Conversation this message belongs to. */
  conversationId: string;
  /** Message text content. */
  text: string;
  /** Lane this message was enqueued to. */
  lane?: string;
  /** Monotonic insertion order (tiebreaker for same-ms UUIDv7s). */
  seq: number;
}

export interface SimInboundMessage extends SimMessageBase {
  direction: "inbound";
  /** Sender ID for the injected user message. */
  senderId: string;
}

export interface SimOutboundMessage extends SimMessageBase {
  direction: "outbound";
  /** Agent that produced this message. */
  agentId: string;
  /** UUIDv7 of the most recent message the agent had in context
   *  when it produced this reply (causal parent). */
  causalParentId: string;
  /** Timestamp of that causal parent message. */
  causalParentTs: number;
  /** Time spent waiting in queue before agent run started (ms). */
  queueWaitMs?: number;
  /** Total agent run duration (ms). */
  runDurationMs?: number;
}
```

The tracker maintains an ordered log of all messages and exposes queries:

```typescript
export class MessageTracker {
  /** Internal storage with indexes for O(1) lookup. */
  private log: SimMessage[] = [];
  private byId = new Map<string, SimMessage>();
  private byConversation = new Map<string, SimMessage[]>();
  private nextSeq = 0;

  /** Record a message and update indexes. */
  record(msg: Omit<SimMessage, "seq">): SimMessage;

  /** All messages in insertion order. */
  messages(): readonly SimMessage[];

  /** Messages for a specific conversation (O(1) lookup). */
  conversation(id: string): readonly SimMessage[];

  /** Get a single message by ID (O(1) lookup). */
  get(id: string): SimMessage | undefined;

  /** Build the causal chain for a message (walk causalParentId links). */
  causalChain(messageId: string): SimMessage[];

  /** Find messages where causalParentId is stale (agent missed messages). */
  staleContextMessages(): SimOutboundMessage[];

  /** Messages per conversation per time window. */
  throughput(windowMs: number): Map<string, number[]>;
}
```

### Research Insights — Message Tracker

**Race Condition Reviewer — Same-ms UUIDv7 Ordering:**

- UUIDv7 random bits within the same millisecond do NOT guarantee monotonic ordering. Two messages created in the same ms may have UUIDv7 IDs that sort incorrectly.
- **Fix**: Add a monotonic `seq` counter (shown above) as a tiebreaker. Sort by `(ts, seq)` not by UUIDv7 string comparison.

**Performance Oracle — Indexed Lookups:**

- Without indexes, `conversation(id)` and `get(id)` are O(n) scans on every call. Symptom detection calls these repeatedly.
- **Fix**: Maintain `byId` Map and `byConversation` Map (shown above). Update on every `record()` call.
- For large simulations (10k+ messages), consider a bounded ring buffer with configurable capacity to limit memory. Emit a warning when the buffer wraps.

**TypeScript Reviewer — Discriminated Union:**

- Use a discriminated union (shown above) instead of optional fields. `direction: "inbound"` narrows to `SimInboundMessage` with required `senderId`; `direction: "outbound"` narrows to `SimOutboundMessage` with required `agentId`, `causalParentId`.
- Rename `processedMessageId` -> `causalParentId` for clarity (what it IS, not how it got there).

#### 3. UUIDv7 (`src/simulation/uuidv7.ts`)

Minimal UUIDv7 implementation using Node.js built-ins (no external dependency):

```typescript
import { randomBytes } from "node:crypto";

export function uuidv7(): string {
  const now = Date.now();
  const timeBytes = Buffer.alloc(6);
  // 48-bit big-endian millisecond timestamp
  timeBytes.writeUIntBE(now, 0, 6);
  const rand = randomBytes(10);
  // Set version (0111) and variant (10xx)
  rand[0] = (rand[0] & 0x0f) | 0x70; // version 7
  rand[2] = (rand[2] & 0x3f) | 0x80; // variant 10
  const hex = Buffer.concat([timeBytes, rand]).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
```

### Research Insights — UUIDv7

**Best Practices:**

- Node.js has no built-in UUIDv7 (not even Node 25). The custom implementation is the right call.
- RFC 9562 specifies UUIDv7. The implementation above is correct per the spec.
- Consider optionally accepting a PRNG function for test determinism: `uuidv7(rng?: () => Buffer)`.

#### 4. Fake Channel (`src/simulation/fake-channel.ts`)

A `ChannelPlugin` implementation that generates inbound messages from the scenario and captures outbound replies. **Must compose on top of `createChannelTestPluginBase()`** to satisfy all required `ChannelMeta` fields.

```typescript
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";

export function createFakeChannelPlugin(params: {
  channelType: string;
  tracker: MessageTracker;
  onOutbound?: (msg: SimMessage) => void;
}): ChannelPlugin {
  const base = createChannelTestPluginBase({
    channelId: params.channelType,
    // base provides: id, meta (with label, selectionLabel, blurb, docsPath),
    // capabilities, config scaffolding
  });

  return {
    ...base,
    outbound: {
      deliveryMode: "direct",
      sendText: async (ctx) => {
        const msg: SimOutboundMessage = {
          id: uuidv7(),
          ts: Date.now(),
          seq: 0, // assigned by tracker.record()
          direction: "outbound",
          conversationId: ctx.to,
          agentId: "unknown", // enriched by runner via causal metadata
          text: ctx.text,
          causalParentId: "", // enriched from fake provider response template
          causalParentTs: 0,
        };
        params.tracker.record(msg);
        params.onOutbound?.(msg);
        return { channel: params.channelType, messageId: msg.id };
      },
    },
  };
}
```

### Research Insights — Fake Channel

**Pattern Recognition Specialist:**

- The codebase has `createChannelTestPluginBase()` in `src/test-utils/channel-plugins.ts` that handles all required `ChannelMeta` fields correctly. The plan's original fake channel would fail to compile because `ChannelMeta` requires `selectionLabel`, `blurb`, and a proper `id`.
- **Always compose on top of `createChannelTestPluginBase()`** — it handles capability declarations, config scaffolding, and meta correctly.

**Architecture Strategist:**

- The fake channel's `sendText` handler is where causal metadata propagation must happen. The fake provider embeds the causal parent info in its response text (via template interpolation). The fake channel must extract it before recording to the tracker. Consider a structured sideband (e.g., a Map keyed by conversation ID) rather than parsing text.

#### 5. Fake LLM Provider (`src/simulation/fake-provider.ts`)

Hooks into `@mariozechner/pi-ai`'s `streamSimple` to return scripted responses with configurable latency. **Injected via the new `streamFnOverride` param** on `RunEmbeddedPiAgentParams`.

```typescript
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

export function createFakeStreamFn(params: {
  models: Record<
    string,
    {
      latencyMs: number;
      response: string;
      errorRate?: number;
    }
  >;
  tracker: MessageTracker;
  signal?: AbortSignal;
  rng?: () => number; // seeded PRNG for deterministic error injection
}) {
  return (model, context, options) => {
    const modelCfg = params.models[model.id] ?? { latencyMs: 100, response: "ok" };
    const stream = createAssistantMessageEventStream();
    const random = params.rng ?? Math.random;

    const lastUserMsg = findLastUserMessage(context);

    const timer = setTimeout(() => {
      // Check abort before pushing (prevents ghost replies after SIGINT)
      if (params.signal?.aborted) {
        stream.error(new Error("Simulation aborted"));
        return;
      }

      if (modelCfg.errorRate && random() < modelCfg.errorRate) {
        stream.error(new Error("Simulated provider error"));
        return;
      }

      const responseText = interpolateTemplate(modelCfg.response, {
        agentId: model.id,
        messageId: lastUserMsg?.id,
      });

      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: responseText }],
          stopReason: "stop",
          usage: { input: 100, output: 50, total: 150 },
        },
      });
      // Note: "done" is a terminal event — stream.end() after push is redundant
      // per AssistantMessageEventStream semantics.
    }, modelCfg.latencyMs);

    // Clean up timer on abort to prevent ghost replies
    params.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });

    return stream;
  };
}
```

### Research Insights — Fake Provider

**Architecture Strategist — `streamFnOverride` Injection:**

- This is the **critical missing piece** in the original plan. `src/agents/pi-embedded-runner/run/attempt.ts:871` hardcodes `streamSimple`. Without Vitest module mocking, the fake provider has no way in.
- **Required change** to `RunEmbeddedPiAgentParams`:

  ```typescript
  streamFnOverride?: StreamFn;
  ```

- **Required change** to `attempt.ts:871`:

  ```typescript
  activeSession.agent.streamFn = params.streamFnOverride ?? streamSimple;
  ```

- This is independently useful for any future testing or simulation work.

**Race Condition Reviewer — Ghost Replies After SIGINT:**

- Bare `setTimeout` fires even after simulation cleanup. The fake provider's timer continues running after `AbortController.abort()` is called.
- **Fix**: Check `signal.aborted` before `stream.push()` and register an abort listener that calls `clearTimeout(timer)` (shown above).

**Race Condition Reviewer — setTimeout Ordering:**

- Multiple `setTimeout` calls with the same delay do not guarantee FIFO ordering in Node.js. Two fake providers with `latencyMs: 2000` may complete in either order.
- **Documented nondeterminism**: This is acceptable and even realistic (real LLM providers have variable latency). Document that same-latency responses may arrive in any order unless `seed` is set and a deterministic timer is used.

**TypeScript Reviewer:**

- Type the `createFakeStreamFn` return value explicitly to match the `streamSimple` signature from `@mariozechner/pi-ai`. Ensures compile-time compatibility with the `streamFnOverride` param.
- Remove `stream.end()` after pushing a terminal event — `AssistantMessageEventStream` auto-completes on `"done"` or `"error"`.

#### 6. Queue Monitor (`src/simulation/queue-monitor.ts`)

Subscribes to diagnostic events and periodically snapshots lane state:

```typescript
import { onDiagnosticEvent } from "../infra/diagnostic-events.js";
import { getAllLaneInfo } from "../process/command-queue.js";
import type { LaneInfo } from "../process/command-queue.js";

export interface LaneSnapshot {
  ts: number;
  lane: string;
  queued: number;
  active: number;
  maxConcurrent: number;
}

export interface QueueTimeline {
  snapshots: LaneSnapshot[];
  events: DiagnosticEventPayload[];
}

export class QueueMonitor {
  private timeline: QueueTimeline = { snapshots: [], events: [] };
  private dispose?: () => void;
  private interval?: ReturnType<typeof setInterval>;
  private lanePrefix?: string;

  start(sampleIntervalMs: number, lanePrefix?: string) {
    this.lanePrefix = lanePrefix;

    // Subscribe to diagnostic events
    this.dispose = onDiagnosticEvent((evt) => {
      this.timeline.events.push(evt);
    });

    // Periodic lane snapshots
    this.interval = setInterval(() => {
      const allLanes = getAllLaneInfo();
      const filtered = this.lanePrefix
        ? allLanes.filter((l) => l.lane.startsWith(this.lanePrefix!))
        : allLanes;

      for (const info of filtered) {
        this.timeline.snapshots.push({
          ts: Date.now(),
          lane: info.lane,
          queued: info.queued,
          active: info.active,
          maxConcurrent: info.maxConcurrent,
        });
      }
    }, sampleIntervalMs);
  }

  stop(): QueueTimeline {
    this.dispose?.();
    clearInterval(this.interval);
    return this.timeline;
  }
}
```

**Required change to command-queue.ts**: Expose a `getAllLaneInfo()` function that returns queue depth + active count + maxConcurrent per lane. Today `getQueueSize()` returns queued + active combined — we need them separated, and we need lane enumeration.

```typescript
// New export in src/process/command-queue.ts
export interface LaneInfo {
  lane: string;
  queued: number;
  active: number;
  maxConcurrent: number;
  generation: number;
}

export function getAllLaneInfo(): LaneInfo[] {
  return [...lanes.entries()].map(([name, state]) => ({
    lane: name,
    queued: state.queue.length,
    active: state.activeTaskIds.size,
    maxConcurrent: state.maxConcurrent,
    generation: state.generation,
  }));
}
```

### Research Insights — Queue Monitor

**Performance Oracle:**

- `getAllLaneInfo()` should optionally accept a prefix filter to avoid copying the entire lane map when the simulation only cares about `sim:*` lanes:

  ```typescript
  export function getAllLaneInfo(prefix?: string): LaneInfo[] {
    const result: LaneInfo[] = [];
    for (const [name, state] of lanes) {
      if (prefix && !name.startsWith(prefix)) continue;
      result.push({ lane: name, queued: state.queue.length, ... });
    }
    return result;
  }
  ```

- For high-frequency sampling (every 100ms with many lanes), the snapshot array can grow large. Consider a bounded ring buffer or periodic flush to disk for long-running simulations.

**Diagnostic Event Explorer — Existing Events:**

- 13 existing diagnostic event types discovered. The 3 new events (task complete, task error, concurrency change) fit cleanly into the existing `DiagnosticEventPayload` discriminated union.
- All diagnostic events have a monotonic `seq` counter and timestamp. The simulation can correlate queue snapshots with events using `(ts, seq)` windows.
- Subscription API: `onDiagnosticEvent(listener)` returns an unsubscribe function. The monitor must call this on `stop()` (shown above).

**Pattern Recognition:**

- New diagnostic events **must** go through the logging layer in `src/logging/diagnostic.ts`, not emit directly from `command-queue.ts`. Add:
  - `logLaneTaskComplete(lane, taskId, durationMs)` in `src/logging/diagnostic.ts`
  - `logLaneTaskError(lane, taskId, durationMs, error)` in `src/logging/diagnostic.ts`
  - `logLaneConcurrencyChange(lane, oldMax, newMax)` in `src/logging/diagnostic.ts`
- These functions call `emitDiagnosticEvent()` internally, matching the pattern used by `logLaneEnqueue` and `logLaneDequeue`.

#### 7. Symptom Detector (`src/simulation/symptom-detector.ts`)

Analyzes the message log and queue timeline for known pathologies:

```typescript
/** Discriminated union for detected symptoms. */
export type SimSymptom =
  | SimReplyExplosion
  | SimStaleContext
  | SimQueueBacklog
  | SimLagDrift
  | SimOutOfSync;

interface SimSymptomBase {
  severity: "info" | "warning" | "critical";
  ts: number;
  description: string;
}

export interface SimReplyExplosion extends SimSymptomBase {
  type: "reply_explosion";
  conversationId: string;
  inboundCount: number;
  outboundCount: number;
  ratio: number;
}

export interface SimStaleContext extends SimSymptomBase {
  type: "stale_context";
  messageId: string;
  staleness: number; // messages behind
}

export interface SimQueueBacklog extends SimSymptomBase {
  type: "queue_backlog";
  lane: string;
  depth: number;
  threshold: number;
}

export interface SimLagDrift extends SimSymptomBase {
  type: "lag_drift";
  slopeMs: number;
  conversationId: string;
}

export interface SimOutOfSync extends SimSymptomBase {
  type: "out_of_sync";
  messageIds: [string, string];
  sharedCausalParentId: string;
}

export function detectSymptoms(params: {
  messages: readonly SimMessage[];
  timeline: QueueTimeline;
  thresholds: SymptomThresholds;
}): SimSymptom[] {
  const symptoms: SimSymptom[] = [];

  // Reply explosion: more outbound messages than inbound for a conversation
  detectReplyExplosions(params, symptoms);

  // Lag drift: queue wait time increasing monotonically over time
  detectLagDrift(params, symptoms);

  // Queue backlog: queue depth exceeding threshold
  detectQueueBacklog(params, symptoms);

  // Stale context: agent processed a message that's N messages behind the latest
  detectStaleContext(params, symptoms);

  // Out of sync: two agents in the same conversation both processed the
  // same "most recent" message (neither saw the other's reply)
  detectOutOfSync(params, symptoms);

  return symptoms;
}
```

**Detection heuristics:**

| Symptom         | Detection Rule                                                             |
| --------------- | -------------------------------------------------------------------------- |
| Reply explosion | outbound count > inbound count \* maxExpectedRatio for a conversation      |
| Lag drift       | EWMA on queue wait times has positive slope > threshold                    |
| Queue backlog   | Any lane snapshot where queued > configurable threshold                    |
| Stale context   | Agent's `causalParentId` is > N messages behind the actual latest          |
| Out of sync     | Two outbound messages in same conversation share the same `causalParentId` |

### Research Insights — Symptom Detection

**Best Practices Researcher — EWMA for Lag Drift:**

- Instead of O(n) linear regression, use Exponentially Weighted Moving Average for streaming detection:

  ```typescript
  class EWMADetector {
    private ewma = 0;
    private alpha: number;
    constructor(alpha = 0.3) {
      this.alpha = alpha;
    }
    update(waitMs: number): number {
      this.ewma = this.alpha * waitMs + (1 - this.alpha) * this.ewma;
      return this.ewma;
    }
  }
  ```

- Detect drift when EWMA crosses a configurable threshold. This is O(1) per message and avoids storing a sliding window of raw values.

**Performance Oracle — Incremental Detection:**

- Symptom detection should run incrementally on new messages, not re-scan the entire log on each check. The detector should maintain state between calls.
- For queue backlog, check each new snapshot against the threshold — no need to scan all historical snapshots.

**Implementation order:**

- Start with reply explosion, stale context, queue backlog (simplest to implement and most diagnostic). Then add lag drift (EWMA) and out-of-sync once the core pipeline works.
- The discriminated union (shown above) replaces the original `evidence: Record<string, unknown>` bag with typed, exhaustive fields per symptom type.

#### 8. Report Writer (`src/simulation/report.ts`)

Generates a machine-readable JSON report:

**JSON report** (`sim-report.json`):

```json
{
  "scenario": "reply-explosion-under-burst",
  "seed": 42,
  "startedAt": "2026-02-26T10:00:00.000Z",
  "durationMs": 15000,
  "summary": {
    "totalMessages": 20,
    "inbound": 10,
    "outbound": 10,
    "conversations": 1,
    "symptomCount": { "critical": 1, "warning": 2, "info": 0 }
  },
  "messages": [],
  "timeline": {},
  "symptoms": [],
  "assertions": [{ "name": "max_queue_depth", "passed": false, "actual": 8, "threshold": 5 }]
}
```

### Research Insights — Report

**Report formats:**

- JSON report is the primary machine-readable output. Markdown report provides human-readable summaries with ASCII timeline, symptom descriptions, and assertion results.
- Implement JSON first, then add Markdown rendering as a separate formatter.

**Best Practices Researcher:**

- Include the `seed` in the report so any run can be reproduced.
- Add percentile statistics for queue wait times: p50, p95, p99. These are more actionable than averages.

**Agent-Native Architecture:**

- The report should be a typed `SimReport` interface, not an untyped JSON blob:

  ```typescript
  export interface SimReport {
    scenario: string;
    seed?: number;
    startedAt: string;
    durationMs: number;
    summary: SimSummary;
    messages: SimMessage[];
    timeline: QueueTimeline;
    symptoms: SimSymptom[];
    assertions: SimAssertionResult[];
  }
  ```

- `runSimulation()` returns `Promise<SimReport>` — the CLI serializes it to JSON/file, but programmatic callers get a typed object.

### Phase 1: CLI (`src/commands/sim.ts`)

#### Commands

```
openclaw sim run <scenario.yaml>     Run a simulation scenario
openclaw sim run --live              Enable live terminal dashboard
openclaw sim run --verbose           Stream events to stderr (simpler than --live)
openclaw sim run --report json       Output format (json|markdown|both)
openclaw sim run --out ./reports/    Output directory
openclaw sim list                    List available scenario files
openclaw sim validate <scenario.yaml> Validate scenario without running
```

### Research Insights — CLI

**Implementation order:**

- Implement `--verbose` first (streaming events to stderr — quick win), then layer `--live` TUI on top using `src/terminal/table.ts` and ANSI rendering.
- `openclaw sim list` is a convenience — just lists YAML files from the scenarios directory.

**Security Sentinel:**

- The `--out` flag must only be accepted from CLI invocations, never from agent tool calls. An agent controlling the simulation should not be able to write arbitrary files to disk.
- Use `resolvePreferredOpenClawTmpDir()` from `src/infra/tmp-openclaw-dir.ts` for the simulation temp directory. It enforces `0o700`, handles umask repair, and provides fallback logic.

**Agent-Native Architecture:**

- The CLI should be a thin wrapper around `runSimulation()`:

  ```typescript
  // src/commands/sim.ts
  const report = await runSimulation(scenario, { signal: controller.signal, verbose });
  if (outPath) writeFileSync(join(outPath, "sim-report.json"), JSON.stringify(report, null, 2));
  ```

- This ensures agents can call `runSimulation()` directly without going through the CLI.

#### Live Terminal Dashboard

When `--live` is passed, render a terminal dashboard using the existing `src/terminal/table.ts` utilities and ANSI output:

```
+==============================================================+
|  OpenClaw Simulation: reply-explosion-under-burst            |
|  Elapsed: 3.2s / ~15s                                       |
+==============================================================+
|                                                              |
|  LANES                      QUEUED  ACTIVE  MAX  WAIT(p95)   |
|  session:agent:...:group-42     3       1     1    1200ms    |
|  main                          0       1     3       0ms    |
|                                                              |
|  MESSAGES          IN    OUT   PENDING   STALE               |
|  conv-1            7      3        4       1                 |
|                                                              |
|  SYMPTOMS                                                    |
|  ! lag_drift: queue wait increasing +200ms/msg (conv-1)      |
|  ! stale_context: agent-1 reply based on msg 2/7             |
|                                                              |
|  TIMELINE (last 5s)                                          |
|  ##..##...## enqueue                                         |
|  ..#...#...# dequeue                                         |
|  ......#.... reply                                           |
+==============================================================+
```

Uses the shared CLI palette from `src/terminal/palette.ts` for colors. No external TUI library — just ANSI escape codes + `process.stdout.write()` with a render loop on the monitor's sample interval.

### Phase 2: Web Dashboard

A lightweight web UI served by a standalone HTTP server that connects via WebSocket to a running simulation:

- **Timeline view**: Horizontal swimlanes per conversation, messages as dots/bars, color-coded by agent
- **Queue heatmap**: Lane utilization over time (green -> yellow -> red)
- **Causal graph**: Click a message to see its causal chain (what did this agent see?)
- **Live metrics**: Queue depth, throughput, latency percentiles
- **Scenario controls**: Start/stop/pause, adjust parameters mid-run

Implementation: Serve static HTML/JS from a standalone HTTP server (not the gateway — it may not be running). Use the `onDiagnosticEvent()` subscription piped through a WebSocket. No React/framework — vanilla JS + Canvas or SVG for visualizations.

### Research Insights — Phase 2

**Architecture Strategist:**

- The plan says "served by the gateway's existing HTTP server" but also says the simulation "does not boot the full gateway." These contradict. Phase 2 should use a standalone HTTP server (e.g., `node:http` + static file serving).

**Security Sentinel:**

- WebSocket connections need authentication. Even for a local-only dashboard, bind to `127.0.0.1` only and consider a per-session token to prevent cross-origin attacks.

## Design Decisions

These are the critical architectural choices, surfaced via spec-flow analysis.

### 1. Lightweight gateway, not full `startGatewayServer`

The simulation does **not** boot the full gateway (HTTP servers, Tailscale, cron, browser control, plugin loading). It instantiates only the message processing pipeline: the command queue, lane infrastructure, and agent runner. Fake channels and fake providers are wired directly — no channel manager, no webhook HTTP listener.

**Rationale**: Full gateway is slow to start, introduces port conflicts, and 90% of its surface is irrelevant to queue/lane behavior. The simulation cares about the path from "message arrives" to "reply sent" — which is `enqueueCommandInLane` -> `runEmbeddedPiAgent` -> `streamSimple` -> outbound adapter.

### 2. Fake LLM provider intercepts at `streamSimple` level via `streamFnOverride`

The fake provider replaces `streamSimple` from `@mariozechner/pi-ai` via a new `streamFnOverride` parameter on `RunEmbeddedPiAgentParams`. The simulation provides mock auth profiles (via config injection) that always succeed and a mock model registry that resolves fake model IDs. This means the agent runner's full pipeline runs: model resolution, auth profile selection, failover/retry loop — all against fakes.

**Required changes:**

- Add `streamFnOverride?: StreamFn` to `RunEmbeddedPiAgentParams` (`src/agents/pi-embedded-runner/run/params.ts`)
- Use `params.streamFnOverride ?? streamSimple` at `src/agents/pi-embedded-runner/run/attempt.ts:871`

**Rationale**: Maximum fidelity. The failover/retry loop is exactly where pathological behavior can emerge (e.g., auth cooldown cascading into queue backlog). Bypassing it would miss real bugs. The `streamFnOverride` approach is independently useful for non-Vitest test harnesses.

### 3. UUIDv7 causal tracking is simulation-only, not added to core

The core gateway message model does not get UUIDv7 IDs or causal parents. The simulation wraps inbound/outbound at the channel boundary with its own tracking layer. Causal correlation uses timestamps + lane events from `onDiagnosticEvent()` to determine which messages an agent "saw."

**Rationale**: Adding causal tracking to the core is a large cross-cutting change (session persistence, agent runner, outbound pipeline). The simulation can reconstruct causality externally: when a fake provider receives a `streamSimple` call, the `context` parameter contains the conversation history — the last user message in that context is the causal parent.

### 4. Isolation via temporary directory with hardened permissions

The simulation creates a temporary directory tree using the hardened `resolvePreferredOpenClawTmpDir()` utility from `src/infra/tmp-openclaw-dir.ts` (which enforces `0o700`, handles umask repair, and provides fallback logic) and sets agent/session paths there. No simulation state touches `~/.openclaw/`. After the run, the temp dir is preserved for inspection or cleaned up based on a `--cleanup` flag.

**Rationale**: Production agent sessions are keyed by file path. Running a simulation against `~/.openclaw/` would corrupt real state. The test harness at `src/auto-reply/reply.test-harness.ts` uses the same temp-dir isolation pattern. The `resolvePreferredOpenClawTmpDir()` utility (hardened in v2026.2.26) handles permission enforcement and umask edge cases.

### 5. Additional diagnostic events needed (via logging layer)

The existing events lack task completion and task error signals. The simulation needs:

- `queue.lane.task.complete` — `{ lane, taskId, durationMs }`
- `queue.lane.task.error` — `{ lane, taskId, durationMs, error }`
- `queue.lane.concurrency.change` — `{ lane, oldMax, newMax }`

These are added as logging functions in `src/logging/diagnostic.ts` (e.g., `logLaneTaskComplete`), which call `emitDiagnosticEvent()` internally. The logging functions are called from `command-queue.ts`'s pump function and `setCommandLaneConcurrency`. This matches the established pattern where `logLaneEnqueue` and `logLaneDequeue` already exist.

### 6. Symptom detection thresholds are configurable per-scenario

Default thresholds with per-scenario overrides in the YAML (see scenario definition above). All 5 detectors: reply explosion, lag drift, queue backlog, stale context, out-of-sync.

### 7. Fake channel composes on `createChannelTestPluginBase()`

The fake channel uses `createChannelTestPluginBase()` from `src/test-utils/channel-plugins.ts` as its foundation, then overrides only the `outbound` adapter. This satisfies all required `ChannelMeta` fields and capability declarations without manual duplication.

**Rationale**: `ChannelMeta` requires `selectionLabel`, `blurb`, `id`, and `docsPath`. The test helper handles these correctly. Composing on top ensures the fake channel stays compatible as the interface evolves.

### 8. Abort via AbortController, cleanup via lane prefix

On SIGINT/SIGTERM: the simulation's `AbortController` is aborted, which:

1. Cancels pending `setTimeout` timers in the fake provider (prevents ghost replies)
2. Signals the runner to stop generating traffic
3. Calls a new `resetLanesByPrefix("sim:{runId}:")` to clean up only simulation lanes — NOT `resetAllLanes()` which would destroy all lane state including production lanes if the simulation runs in-process.

The temp directory is preserved (not cleaned up on interrupt) so the operator can inspect partial results.

```typescript
// New export in src/process/command-queue.ts
export function resetLanesByPrefix(prefix: string): void {
  for (const [name, state] of lanes) {
    if (!name.startsWith(prefix)) continue;
    state.generation += 1;
    state.activeTaskIds.clear();
    state.draining = false;
    // Reject pending entries
    const pending = state.queue.splice(0);
    for (const entry of pending) {
      entry.reject(new CommandLaneClearedError(name));
    }
    lanes.delete(name);
  }
}
```

### Research Insights — Design Decisions

**Security Sentinel — Lane Isolation:**

- All simulation lanes MUST use the prefix `sim:{runId}:` (e.g., `sim:abc123:session:agent:1:...`). This ensures `resetLanesByPrefix()` only touches simulation lanes.
- `resetAllLanes()` should NEVER be called from simulation code. It affects production lanes in the same process.

**Race Condition Reviewer — Session State Isolation:**

- The agent runner writes session state to JSONL files. If two simulation runs use the same temp directory, they corrupt each other's state.
- **Fix**: Each simulation run gets a unique `runId` (UUIDv7) and a unique temp directory. The `runId` is used as the lane prefix.

**Architecture Strategist — Auth Faking:**

- Mock auth profiles don't need a separate mock layer. Provide a config object with a fake provider entry:

  ```typescript
  const simConfig = {
    providers: {
      fake: {
        auth: [{ type: "key", key: "sim-key-always-valid" }],
        models: {
          "fake-slow": {
            /* ... */
          },
        },
      },
    },
  };
  ```

- The auth profile selector will use this config without any additional mocking.

## Technical Approach

### File Structure

```
src/simulation/
  index.ts             — Barrel export: runSimulation, types
  scenario.ts          — Scenario loader + validator (YAML -> typed config)
  scenario.schema.ts   — Zod schema for scenario YAML
  uuidv7.ts            — Minimal UUIDv7 generator
  message-tracker.ts   — Message log with causal chain queries + indexes
  fake-channel.ts      — ChannelPlugin composing on createChannelTestPluginBase
  fake-provider.ts     — Mock streamFn with configurable latency + AbortSignal
  queue-monitor.ts     — Diagnostic event subscriber + periodic lane snapshots
  symptom-detector.ts  — Heuristic-based pathology detection (5 detectors)
  report.ts            — JSON + Markdown report generation + typed SimReport
  runner.ts            — Orchestrates scenario execution, returns SimReport
  types.ts             — Shared types (SimMessage union, SimSymptom union, etc.)
src/commands/
  sim.ts               — CLI command: thin wrapper around runSimulation()
scenarios/
  examples/
    reply-explosion.yaml
    lag-drift-steady-load.yaml
    multi-conversation-burst.yaml
    drain-delay-comparison.yaml
```

### Required Changes to Existing Code

1. **`src/process/command-queue.ts`**: Add `getAllLaneInfo(prefix?)` export (read-only snapshot of lane states, ~20 lines). Add `resetLanesByPrefix(prefix)` for simulation cleanup (~15 lines). New diagnostic event emissions go through the logging layer (see #5 below).

2. **`src/logging/diagnostic.ts`**: Add three new logging functions: `logLaneTaskComplete(lane, taskId, durationMs)`, `logLaneTaskError(lane, taskId, durationMs, error)`, `logLaneConcurrencyChange(lane, oldMax, newMax)`. These call `emitDiagnosticEvent()` internally.

3. **`src/infra/diagnostic-events.ts`**: Add three new event types to the `DiagnosticEventPayload` union: `DiagnosticLaneTaskCompleteEvent`, `DiagnosticLaneTaskErrorEvent`, `DiagnosticLaneConcurrencyChangeEvent`.

4. **`src/agents/pi-embedded-runner/run/params.ts`**: Add `streamFnOverride?: StreamFn` to `RunEmbeddedPiAgentParams`.

5. **`src/agents/pi-embedded-runner/run/attempt.ts`**: Line 701 — use `params.streamFnOverride ?? streamSimple` instead of hardcoded `streamSimple`.

6. **`src/cli/program.ts`**: Register the `sim` command group.

### Implementation Phases

#### Phase 1a: Core Engine (Foundation)

- [ ] `src/simulation/uuidv7.ts` — UUIDv7 generator + tests
- [ ] `src/simulation/types.ts` — SimMessage discriminated union, SimSymptom union, ScenarioConfig, SimReport types
- [ ] `src/simulation/message-tracker.ts` — Message log with `byId`/`byConversation` indexes, causal chain queries, stale context detection
- [ ] `src/simulation/scenario.schema.ts` — Zod schema for scenario YAML (strict mode)
- [ ] `src/simulation/scenario.ts` — YAML loader using `yaml` (eemeli) package with `{ schema: "core", strict: true, uniqueKeys: true }`
- [ ] `src/process/command-queue.ts` — Add `getAllLaneInfo(prefix?)` and `resetLanesByPrefix(prefix)` exports
- [ ] `src/logging/diagnostic.ts` — Add `logLaneTaskComplete`, `logLaneTaskError`, `logLaneConcurrencyChange`
- [ ] `src/infra/diagnostic-events.ts` — Add 3 new event types to union
- [ ] `src/agents/pi-embedded-runner/run/params.ts` — Add `streamFnOverride` param
- [ ] `src/agents/pi-embedded-runner/run/attempt.ts` — Use `streamFnOverride ?? streamSimple`
- [ ] Tests for all above

#### Phase 1b: Simulation Components

- [ ] `src/simulation/fake-provider.ts` — Fake streamFn with latency, error injection (seeded PRNG), AbortSignal support
- [ ] `src/simulation/fake-channel.ts` — Fake ChannelPlugin composing on `createChannelTestPluginBase()` for inbound injection + outbound capture
- [ ] `src/simulation/queue-monitor.ts` — Diagnostic event subscriber + periodic lane snapshots with prefix filtering
- [ ] `src/simulation/symptom-detector.ts` — All 5 detectors: reply explosion, lag drift (EWMA), queue backlog, stale context, out-of-sync
- [ ] `src/simulation/report.ts` — Typed SimReport with JSON + Markdown output, assertions, seed, percentile stats
- [ ] Tests for all above

#### Phase 1c: Runner + CLI

- [ ] `src/simulation/runner.ts` — Orchestrates: load scenario -> wire fakes -> generate traffic -> monitor -> detect -> assert -> report. Returns `Promise<SimReport>`.
- [ ] `src/simulation/index.ts` — Barrel export: `runSimulation`, types, `deriveScenario`
- [ ] `src/commands/sim.ts` — CLI: `sim run`, `sim list`, `sim validate` (thin wrapper around `runSimulation()`)
- [ ] All 4 traffic patterns: `burst`, `steady`, `random` (Poisson, seeded PRNG), `replay` (production log)
- [ ] `--verbose` streaming output (diagnostic events to stderr)
- [ ] `--live` terminal dashboard (ANSI rendering using `src/terminal/table.ts` + palette)
- [ ] Example scenario YAML files
- [ ] Integration test: run a scenario end-to-end, verify report output

#### Phase 2: Web Dashboard (Implementation Checklist)

- [ ] Standalone HTTP server (NOT gateway — it may not be running)
- [ ] WebSocket bridge with per-session auth token, bound to `127.0.0.1`
- [ ] Static HTML/JS dashboard
- [ ] Timeline swimlane visualization (Canvas/SVG)
- [ ] Queue heatmap
- [ ] Causal graph explorer
- [ ] Scenario controls (start/stop/pause, parameter adjustment)

## Acceptance Criteria

### Functional Requirements

- [ ] `openclaw sim run scenarios/examples/reply-explosion.yaml` executes and produces a JSON report
- [ ] Every outbound message has a UUIDv7 `id`, `ts`, and `causalParentId` + `causalParentTs`
- [ ] Causal chain is traceable: given any agent reply, you can walk back to see exactly what messages it "saw"
- [ ] Symptom detector identifies reply explosions (outbound > expected ratio)
- [ ] Symptom detector identifies stale context (agent missed recent messages)
- [ ] Symptom detector identifies queue backlog (lane depth > threshold)
- [ ] Symptom detector identifies lag drift (EWMA-based, increasing queue wait)
- [ ] Symptom detector identifies out-of-sync (two agents replied based on same context)
- [ ] `--live` flag shows real-time terminal dashboard
- [ ] `--verbose` flag streams diagnostic events to stderr
- [ ] Report includes assertion pass/fail results
- [ ] All 4 traffic patterns work: burst, steady, random, replay
- [ ] Scenarios are validated before execution (bad YAML -> clear error)
- [ ] `runSimulation()` is exported as a typed API (not just CLI)
- [ ] Simulation seed (when set) produces deterministic results

### Non-Functional Requirements

- [ ] Simulation runs against the real command queue and lane system (not a separate mock queue)
- [ ] No external dependencies beyond what's already in the repo (no Bull, no Redis, no TUI libraries)
- [ ] UUIDv7 implementation uses only Node.js built-ins
- [ ] Scenario files are self-contained YAML (no code required to define a scenario)
- [ ] Uses `yaml` (eemeli) package for YAML parsing — NOT `js-yaml`
- [ ] All simulation lanes use `sim:{runId}:` prefix for isolation
- [ ] Temp directory created via `resolvePreferredOpenClawTmpDir()` with `0o700` permissions

### Quality Gates

- [ ] All new files have colocated `*.test.ts`
- [ ] `pnpm check` passes
- [ ] `pnpm test` passes
- [ ] Files stay under ~500 LOC

## Alternative Approaches Considered

**1. Vitest-only test harness** — Write simulation scenarios as test cases. Rejected: not usable by non-developers, can't be run against a live gateway, no live visualization.

**2. External load testing tool (k6, Artillery)** — Use existing load testing tools against the gateway's HTTP API. Rejected: can't hook into lane internals, no causal tracking, treats gateway as a black box.

**3. Separate simulation binary** — Build the simulation as a standalone package. Rejected: adds build/publish complexity. The simulation needs deep access to gateway internals (queue, diagnostic events, channel plugins). Keeping it in-tree is simpler.

**4. Record-replay from production** — Capture real gateway traffic and replay it. Considered for a follow-up as a `replay` traffic pattern. Not sufficient alone because you need controlled, reproducible scenarios to isolate specific behaviors.

**5. Virtual clock / deterministic simulation testing (DST)** — FoundationDB/TigerBeetle model with a virtual clock and fully deterministic execution. Considered but rejected for Phase 1: requires replacing all `Date.now()` and `setTimeout` calls with injectable time sources throughout the codebase. Too invasive. Seeded PRNG provides sufficient reproducibility for error injection and random traffic patterns without modifying core code.

## Dependencies & Prerequisites

- The simulation runs against the **real command queue** — it imports `enqueueCommandInLane`, `setCommandLaneConcurrency`, etc. directly
- The fake provider needs access to `createAssistantMessageEventStream` from `@mariozechner/pi-ai`
- YAML parsing: use `yaml` (eemeli) package — already in the dependency tree (`src/markdown/frontmatter.ts` uses it)
- The `getAllLaneInfo()`, `resetLanesByPrefix()`, and `streamFnOverride` additions are the required changes to existing code
- New diagnostic event emissions require additions to `src/logging/diagnostic.ts` and `src/infra/diagnostic-events.ts`

## Risk Analysis

| Risk                                                | Likelihood | Impact | Mitigation                                                                                                           |
| --------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| LaneState internals change                          | Low        | Medium | `getAllLaneInfo()` is a thin read-only wrapper; easy to update                                                       |
| Fake provider doesn't match real streaming behavior | Medium     | Medium | Use `createAssistantMessageEventStream` from pi-ai (same path as real provider). Check `signal.aborted` before push. |
| Simulation affects real queue state                 | Medium     | High   | `sim:{runId}:` lane prefix + `resetLanesByPrefix()` for cleanup. Never call `resetAllLanes()`.                       |
| Ghost replies after abort                           | Medium     | Medium | AbortSignal + `clearTimeout` in fake provider (prevents timer fire after cleanup)                                    |
| Same-ms UUIDv7 ordering                             | Low        | Low    | Monotonic `seq` counter as tiebreaker. Document nondeterminism for same-latency responses.                           |
| Session state corruption between runs               | Low        | High   | Unique temp directory per run with `resolvePreferredOpenClawTmpDir()`                                                |
| Terminal dashboard flickers/performance             | Low        | Low    | Throttle render to sample interval, use differential updates. `--verbose` available as lightweight alternative.      |
| Scenario YAML becomes complex                       | Medium     | Low    | Start simple, add features incrementally. Provide good examples.                                                     |

## Future Considerations

- **Conversation lane support**: When `maxConcurrentPerConversation` and `conversationLaneDrainDelayMs` land, add them as first-class scenario config parameters and add specific symptom detectors for their behavior.
- **Replay from production**: Parse gateway diagnostic logs and reconstruct traffic patterns for replay scenarios.
- **Comparison mode**: Run the same scenario with different configs side-by-side and diff the reports.
- **CI integration**: Run simulation scenarios as part of CI to catch regression in queue behavior (assertion-based pass/fail).
- **Distributed simulation**: Simulate multiple gateway instances with shared state (for future multi-node support).
- **Virtual clock (DST)**: Full deterministic simulation testing with injectable time sources, if reproducibility with seeded PRNG proves insufficient.
- **Monotonic conversation sequence numbers**: Per-conversation counters alongside UUIDv7 for human-readable ordering.
- **Parameter sweep utility**: `parameterSweep(base, "config.agents.defaults.maxConcurrent", [1, 2, 3, 5])` returns an array of derived scenarios.

## References

### Internal

- Command queue: `src/process/command-queue.ts`
- Diagnostic events: `src/infra/diagnostic-events.ts`
- Diagnostic logging: `src/logging/diagnostic.ts`
- Channel plugin types: `src/channels/plugins/types.plugin.ts`
- Channel test helpers: `src/test-utils/channel-plugins.ts` (`createChannelTestPluginBase`)
- Agent runner: `src/agents/pi-embedded-runner/run.ts`
- Agent run params: `src/agents/pi-embedded-runner/run/params.ts`
- Agent run attempt (streamFn assignment): `src/agents/pi-embedded-runner/run/attempt.ts:871`
- CLI deps: `src/cli/deps.ts`
- Lane constants: `src/process/lanes.ts`
- Terminal utilities: `src/terminal/table.ts`, `src/terminal/palette.ts`
- CLI progress: `src/cli/progress.ts`
- YAML parsing pattern: `src/markdown/frontmatter.ts` (`import YAML from "yaml"`)
- Temp dir isolation pattern: `src/auto-reply/reply.test-harness.ts`
- Hardened temp dir utility: `src/infra/tmp-openclaw-dir.ts` (`resolvePreferredOpenClawTmpDir`)

### Institutional Learnings

- Per-channel config cascade: `docs/solutions/configuration-fixes/per-channel-config-cascade-override.md`
- Cross-agent session awareness: `docs/brainstorms/2026-02-21-conversation-lane-debounce-brainstorm.md`
- Drain delay design: `docs/plans/2026-02-22-fix-concurrent-agent-session-awareness-plan.md`

### Related

- PR #23188: Per-channel conversation concurrency override (provides the `maxConcurrentPerConversation` config the simulation will exercise)
- Conversation lane drain delay (standby branch): Provides `conversationLaneDrainDelayMs`
