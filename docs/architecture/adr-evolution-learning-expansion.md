# ADR: Autonomous Evolution, Learning & Expansion Architecture

> Status: Draft
> Date: 2026-05-14
> Author: OpenClaw Architecture

---

## 1. Background & Problem Statement

### 1.1 Current System Scale

| Layer                                 | Count          | Coverage                                                                                                                        |
| ------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Core modules (`src/`)                 | 80+ subsystems | Gateway, Agents, Plugins, Channels, ACP, MCP, Sessions, Tasks, Hooks, Cron, Context Engine, Trajectory, Commitments, Routing... |
| Extensions (`extensions/`)            | 126            | 50+ AI providers, 20+ messaging platforms, memory systems, browser automation, trading...                                       |
| Skills (`skills/`)                    | 59             | coding-agent, taskflow, github, skill-creator...                                                                                |
| Automation agents (`.agents/skills/`) | 19             | ClawSweeper, PR maintainer, QA testing, release...                                                                              |
| Native apps (`apps/`)                 | 5              | iOS, macOS, Android, MLX-TTS, Swabble                                                                                           |
| Packages (`packages/`)                | 4              | Plugin SDK, Memory Host SDK, SDK...                                                                                             |
| npm scripts                           | 400+           | brokerdesk HFT, autonomous, canvas...                                                                                           |
| Plugin hooks                          | 36 typed       | Agent lifecycle, message, tool, session, subagent, gateway, install                                                             |
| Internal hooks                        | 12 event types | command, session, agent, gateway, message                                                                                       |
| Provider runtime hooks                | 43             | Full LLM provider lifecycle                                                                                                     |

### 1.2 Existing Learning Mechanisms (Scattered)

| Mechanism        | Location                                        | What It Does                                                  | Limitation                                                |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| Dreaming         | `extensions/memory-core`                        | light/REM/deep memory consolidation                           | Only consolidates memory, doesn't feed back into behavior |
| Active Memory    | `extensions/active-memory`                      | Circuit breaker, adaptive thinking, blocking sub-agent recall | Reads memory but doesn't learn from outcomes              |
| Memory LanceDB   | `extensions/memory-lancedb`                     | Vector embedding storage, auto-capture/recall                 | Stores but doesn't analyze patterns                       |
| Memory Wiki      | `extensions/memory-wiki`                        | Obsidian knowledge vault compiler                             | Static compilation, no growth                             |
| Hermes Learning  | `extensions/hermes-agent/src/learning.ts`       | Success/failure pattern recording (max 200)                   | Records but doesn't update routing or strategy            |
| Hermes Promotion | `extensions/hermes-agent/src/promotion.ts`      | Validation gate (staging -> promoted/rolled_back)             | Binary pass/fail, no gradient                             |
| MSTeams Feedback | `extensions/msteams/src/feedback-reflection.ts` | Thumbs-down triggers reflection loop                          | Channel-specific, doesn't propagate                       |
| Trajectory       | `src/trajectory/`                               | Execution trace recording & export                            | Records but never feeds back                              |
| Commitments      | `src/commitments/`                              | Commitment tracking, model selection learning                 | Narrow scope (model selection only)                       |
| Context Engine   | `src/context-engine/`                           | Pluggable context assembly/compaction                         | Framework only, no self-improvement                       |
| Hooks System     | `src/hooks/`                                    | 36 typed event hooks                                          | Passive plumbing, no adaptive behavior                    |
| Cron/Heartbeat   | `src/cron/`                                     | Scheduled execution, heartbeat policy                         | Fixed schedules, no adaptive timing                       |

### 1.3 What's Missing

The system has 126 extensions, 80+ core modules, and 59 skills, but they are **statically assembled**. Every component is a dead part bolted together with fixed interfaces. The system lacks four fundamental architectural layers that would make it a **living, growing organism**.

| Missing Layer                       | What It Means                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Operational Learning**            | Every operation produces learning data that is discarded. Use-and-forget instead of use-and-grow.               |
| **Neural Module**                   | All connections are hardwired. No dynamic weights, no competitive activation, no adaptive routing.              |
| **Pervasive Growth Mode**           | Dreaming only runs in memory-core. The other 125 extensions and 79 core modules never grow.                     |
| **Biomimetic Organic Architecture** | The system is a machine (assembled from dead parts) instead of an organism (alive, self-healing, metabolizing). |

---

## 2. Design Principles

### 2.1 Architectural Compliance (Non-Negotiable)

These rules come from `AGENTS.md` and `extensions/AGENTS.md` and cannot be violated:

| Rule                               | Source                                        | Implication                                                                |
| ---------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| Extensions are third-party plugins | `extensions/AGENTS.md`                        | Import only from `openclaw/plugin-sdk/*`                                   |
| No core modifications              | `AGENTS.md` Architecture                      | Never import or modify `src/**`                                            |
| Manifest-first                     | Plugin Architecture                           | Declare capabilities in `openclaw.plugin.json` before runtime registration |
| Hook-based integration             | 36 typed plugin hooks                         | Use `api.on()` to hook into lifecycle, never modify core flow              |
| Lazy loading                       | Existing pattern (memory-core, active-memory) | Don't initialize until first use, don't impact startup performance         |
| Plugin State Store                 | `plugin-state-store.ts`                       | Use SQLite or JSON via official API, don't invent storage                  |
| No cross-extension imports         | `extensions/AGENTS.md`                        | Extensions cannot import another extension's `src/**`                      |
| Backwards-compatible seams         | `AGENTS.md`                                   | New seams must be versioned, documented, and backwards-compatible          |

### 2.2 Design Philosophy

| Principle                                | Meaning                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Grow from existing seams**             | Don't build new infrastructure. Use hooks, memory, plugin state, cron that already exist.            |
| **Each stage is independently valuable** | Stage 1 works alone. Stage 2 enhances Stage 1. No stage requires all four to function.               |
| **Fail-open by default**                 | If any evolution component fails, the system behaves exactly as it does today. Zero regression risk. |
| **Observable before autonomous**         | Every learning action is logged and auditable before it's allowed to act autonomously.               |
| **Organic, not mechanical**              | Design for growth, adaptation, and self-healing, not just configuration and deployment.              |

---

## 3. Architecture Overview

### 3.1 Four-Layer Evolution Stack

```
+=====================================================================+
|                                                                     |
|  Layer 4: ORGANIC CELLS          extensions/organic-cells/          |
|  (Biomimetic Architecture)                                          |
|  Cell registry, metabolism, immune system, endocrine, stem pool,    |
|  DNA integrity checks                                               |
|                                                                     |
+---------------------------------------------------------------------+
|                                                                     |
|  Layer 3: GROWTH PULSE           extensions/growth-pulse/           |
|  (Pervasive Growth Mode)                                            |
|  Heartbeat-driven growth cycles: light (hourly), REM (daily),       |
|  deep (weekly). Aligned with memory-core Dreaming phases.           |
|                                                                     |
+---------------------------------------------------------------------+
|                                                                     |
|  Layer 2: NEURAL ROUTER          extensions/neural-router/          |
|  (Dynamic Synaptic Routing)                                         |
|  Synapse weights, activation thresholds, competitive path           |
|  selection, weight decay. Powered by Stage 1 learning data.         |
|                                                                     |
+---------------------------------------------------------------------+
|                                                                     |
|  Layer 1: OPERATIONAL LEARNING   extensions/operational-learning/   |
|  (Use-and-Grow Closed Loop)                                         |
|  Collects signals from every hook event, analyzes patterns,         |
|  feeds insights back via before_prompt_build.                       |
|                                                                     |
+=====================================================================+
|                                                                     |
|  EXISTING OPENCLAW FOUNDATION                                       |
|  126 extensions | 80+ core modules | 36 hooks | 59 skills          |
|  Plugin SDK | Memory (core + LanceDB + wiki + active) | Trajectory  |
|  Commitments | Context Engine | Cron | Hermes Agent                 |
|                                                                     |
+=====================================================================+
```

### 3.2 Inter-Layer Communication (Compliant)

Extensions cannot import each other's `src/`. Compliant communication channels:

```
                    +-------------------+
                    |   Memory Store    |  <-- shared read/write via memory tools
                    +-------------------+
                           |
    +-----------+    +-----------+    +-----------+    +-----------+
    | Op Learn  |    | Neural R  |    | Growth P  |    | Organic C |
    +-----------+    +-----------+    +-----------+    +-----------+
           |               |               |               |
           +-------+-------+-------+-------+-------+-------+
                   |               |               |
           +---------------+ +-----------+ +---------------+
           | Plugin State  | | Hook Order| | Tool Calls    |
           | (JSON files)  | | (priority)| | (in subagent) |
           +---------------+ +-----------+ +---------------+
```

| Channel       | How                                                                         | Example                                                                                    |
| ------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Memory Store  | Write learning results to memory, other extensions read via `memory_search` | Op-Learning writes pattern -> Neural Router reads pattern                                  |
| Plugin State  | Shared state directory with JSON files                                      | Op-Learning writes weights.json -> Neural Router reads weights.json                        |
| Hook Priority | `before_prompt_build` priority ordering controls injection sequence         | Op-Learning (priority: 100) -> Neural Router (priority: 90) -> Growth Pulse (priority: 80) |
| Tool Calls    | One extension registers a tool, another calls it in a subagent              | Op-Learning registers `learning_insights` -> Growth Pulse queries it                       |

---

## 4. Layer 1: Operational Learning

### 4.1 Purpose

Transform every OpenClaw operation into a learning signal. Currently the system is **use-and-forget**. This layer makes it **use-and-grow**.

### 4.2 Data Flow

```
User operates OpenClaw
    |
    v
+-- after_tool_call hook ---------> Tool outcome record
+-- model_call_ended hook --------> Model performance record
+-- agent_end hook ---------------> Session outcome record
+-- session_end hook --------------> Session statistics record
    |
    v
Pattern Analyzer (async, non-blocking)
    |
    v
+-- Weight matrix update
+-- Pattern library update
+-- Preference model update
    |
    v
before_prompt_build hook ----------> Inject learned insights into next session
```

### 4.3 File Structure

```
extensions/operational-learning/
  openclaw.plugin.json        # manifest
  package.json
  api.ts                      # public barrel
  index.ts                    # definePluginEntry
  src/
    collector.ts              # Hook event -> structured learning record
    analyzer.ts               # Pattern extraction from collected records
    weight-store.ts           # Persistent weight matrix (plugin state)
    injector.ts               # Format learned insights for prompt injection
    tools.ts                  # learning_insights, learning_stats tools
    types.ts                  # Shared type definitions
    decay.ts                  # Time-based weight decay (recency half-life)
```

### 4.4 Manifest

```json
{
  "id": "operational-learning",
  "activation": { "onStartup": true },
  "contracts": {
    "tools": ["learning_insights", "learning_stats"]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean", "default": true },
      "maxRecords": {
        "type": "number",
        "default": 2000,
        "description": "Maximum learning records to retain"
      },
      "decayHalfLifeHours": {
        "type": "number",
        "default": 168,
        "description": "Recency half-life in hours (default: 7 days)"
      },
      "minConfidence": {
        "type": "number",
        "default": 0.6,
        "description": "Minimum confidence threshold for pattern injection"
      },
      "analysisIntervalMs": {
        "type": "number",
        "default": 300000,
        "description": "Batch analysis interval (default: 5 minutes)"
      },
      "promptInjection": {
        "type": "boolean",
        "default": true,
        "description": "Whether to inject learned patterns into prompts"
      }
    }
  }
}
```

### 4.5 Entry Point

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "operational-learning",
  name: "Operational Learning",
  description: "Learns from every operation cycle, transforming use-and-forget into use-and-grow.",

  register(api: OpenClawPluginApi) {
    // --- Collection Layer (void hooks, observe-only, never block) ---

    api.on("after_tool_call", async (event, ctx) => {
      const { collectToolOutcome } = await import("./src/collector.js");
      await collectToolOutcome(api, event, ctx);
    });

    api.on("model_call_ended", async (event, ctx) => {
      const { collectModelPerformance } = await import("./src/collector.js");
      await collectModelPerformance(api, event, ctx);
    });

    api.on("agent_end", async (event, ctx) => {
      const { collectSessionOutcome } = await import("./src/collector.js");
      await collectSessionOutcome(api, event, ctx);
    });

    api.on("session_end", async (event, ctx) => {
      const { collectSessionStats } = await import("./src/collector.js");
      await collectSessionStats(api, event, ctx);
    });

    // --- Injection Layer (modifying hook, same pattern as active-memory) ---

    api.on("before_prompt_build", async (event, ctx) => {
      const { injectLearnedPatterns } = await import("./src/injector.js");
      return injectLearnedPatterns(api, event, ctx);
    });

    // --- Tool Registration (lazy-loaded) ---

    api.registerTool({
      name: "learning_insights",
      description: "Query learned patterns and operational insights",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for patterns" },
          category: {
            type: "string",
            enum: ["tool", "model", "route", "preference", "all"],
            default: "all",
          },
          limit: { type: "number", default: 10 },
        },
      },
      handler: async (params) => {
        const { queryInsights } = await import("./src/tools.js");
        return queryInsights(api, params);
      },
    });

    api.registerTool({
      name: "learning_stats",
      description: "View learning system statistics and growth metrics",
      parameters: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["hour", "day", "week", "month", "all"],
            default: "week",
          },
        },
      },
      handler: async (params) => {
        const { getStats } = await import("./src/tools.js");
        return getStats(api, params);
      },
    });
  },
});
```

### 4.6 Learning Record Types

```typescript
// src/types.ts

export type LearningCategory = "tool" | "model" | "route" | "preference" | "strategy";

export type LearningRecord = {
  id: string;
  category: LearningCategory;
  timestamp: number;
  sessionKey?: string;
  agentId?: string;

  // What happened
  action: string;
  target: string;
  params?: Record<string, unknown>;

  // Outcome
  success: boolean;
  durationMs?: number;
  errorType?: string;

  // Derived
  weight: number; // Current weight after decay
  confidence: number; // Statistical confidence
  occurrences: number; // How many times this pattern appeared
};

export type LearnedPattern = {
  id: string;
  category: LearningCategory;
  pattern: string;
  description: string;
  weight: number;
  confidence: number;
  firstSeen: number;
  lastSeen: number;
  occurrences: number;
  successRate: number;
  avgDurationMs?: number;
};

export type WeightMatrix = {
  version: 1;
  updatedAt: number;
  tools: Record<string, number>; // tool name -> effectiveness weight
  models: Record<string, number>; // model id -> performance weight
  routes: Record<string, number>; // route pattern -> success weight
  strategies: Record<string, number>; // strategy name -> outcome weight
};
```

### 4.7 Collector Logic

```typescript
// src/collector.ts

import type { LearningRecord } from "./types.js";

export async function collectToolOutcome(
  api: OpenClawPluginApi,
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookAgentContext,
): Promise<void> {
  const record: LearningRecord = {
    id: crypto.randomUUID(),
    category: "tool",
    timestamp: Date.now(),
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    action: "tool_call",
    target: event.toolName,
    params: event.params,
    success: !event.error,
    durationMs: event.durationMs,
    errorType: event.error?.type,
    weight: 1.0,
    confidence: 0,
    occurrences: 1,
  };

  await appendRecord(api, record);
}

export async function collectModelPerformance(
  api: OpenClawPluginApi,
  event: PluginHookModelCallEndedEvent,
  ctx: PluginHookAgentContext,
): Promise<void> {
  const record: LearningRecord = {
    id: crypto.randomUUID(),
    category: "model",
    timestamp: Date.now(),
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    action: "model_call",
    target: `${event.provider}/${event.modelId}`,
    success: !event.error,
    durationMs: event.durationMs,
    weight: 1.0,
    confidence: 0,
    occurrences: 1,
  };

  await appendRecord(api, record);
}

async function appendRecord(api: OpenClawPluginApi, record: LearningRecord): Promise<void> {
  // Use plugin state store for persistence
  const stateDir = api.resolveStateDir("operational-learning");
  const recordsPath = path.join(stateDir, "records.jsonl");

  await fs.appendFile(recordsPath, JSON.stringify(record) + "\n", "utf-8");
}
```

---

## 5. Layer 2: Neural Router

### 5.1 Purpose

Replace hardwired routing with dynamic synaptic connections. Every extension-to-extension and model-selection path gets a weight that strengthens with success and decays with failure.

### 5.2 Data Flow

```
Layer 1 learning data
    |
    v
Synapse Weight Matrix
    |
    v
+-- before_model_resolve hook ----> Dynamic model/provider selection
+-- agent_turn_prepare hook ------> Context-aware route preparation
+-- model_call_ended hook --------> Weight update from outcome
    |
    v
Competitive activation: context signal * synapse weight -> ranked paths
    |
    v
Winner path executes, loser paths decay slightly
```

### 5.3 File Structure

```
extensions/neural-router/
  openclaw.plugin.json
  package.json
  api.ts
  index.ts
  src/
    synapse-weights.ts        # Weight matrix CRUD
    activation.ts             # Activation threshold functions
    compete.ts                # Multi-path competitive selection
    decay.ts                  # Weight decay over time
    context-signal.ts         # Extract context signals from events
    types.ts                  # Type definitions
```

### 5.4 Manifest

```json
{
  "id": "neural-router",
  "activation": { "onStartup": true },
  "contracts": {
    "tools": ["neural_weights", "neural_topology"]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean", "default": true },
      "learningRate": {
        "type": "number",
        "default": 0.05,
        "description": "How fast weights update (0-1, higher = faster adaptation)"
      },
      "decayRate": {
        "type": "number",
        "default": 0.01,
        "description": "How fast unused paths decay (0-1, higher = faster pruning)"
      },
      "activationThreshold": {
        "type": "number",
        "default": 0.3,
        "description": "Minimum weight for a path to be considered (0-1)"
      },
      "competitionPoolSize": {
        "type": "number",
        "default": 3,
        "description": "Number of candidate paths to evaluate in competition"
      },
      "explorationRate": {
        "type": "number",
        "default": 0.1,
        "description": "Probability of exploring a non-optimal path (0-1)"
      }
    }
  }
}
```

### 5.5 Synapse Weight Types

```typescript
// src/types.ts

export type SynapseId = string; // format: "{source}:{target}"

export type Synapse = {
  id: SynapseId;
  source: string; // e.g., "task:code-review"
  target: string; // e.g., "model:claude-opus-4-6"
  weight: number; // 0.0 - 1.0
  activationCount: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  lastActivated: number;
  lastUpdated: number;
  created: number;
};

export type ActivationSignal = {
  context: string; // what triggered this decision
  candidates: Synapse[]; // all possible paths
  winner: Synapse; // selected path
  reason: "weight" | "exploration" | "fallback";
};

export type NeuralTopology = {
  version: 1;
  updatedAt: number;
  synapses: Record<SynapseId, Synapse>;
  totalActivations: number;
  totalExplorations: number;
  avgSuccessRate: number;
};
```

### 5.6 Competitive Activation Logic

```typescript
// src/compete.ts

export function selectPath(candidates: Synapse[], config: NeuralRouterConfig): ActivationSignal {
  // Filter by activation threshold
  const eligible = candidates.filter((s) => s.weight >= config.activationThreshold);

  if (eligible.length === 0) {
    // Fallback: use highest weight regardless of threshold
    const fallback = candidates.reduce((a, b) => (a.weight > b.weight ? a : b));
    return { context: "no-eligible", candidates, winner: fallback, reason: "fallback" };
  }

  // Exploration: with probability explorationRate, pick a random eligible path
  if (Math.random() < config.explorationRate) {
    const explored = eligible[Math.floor(Math.random() * eligible.length)];
    return { context: "exploration", candidates, winner: explored, reason: "exploration" };
  }

  // Competition: select highest weight
  const winner = eligible.reduce((a, b) => (a.weight > b.weight ? a : b));
  return { context: "competition", candidates, winner, reason: "weight" };
}
```

### 5.7 Weight Update Rule

```typescript
// src/synapse-weights.ts

export function updateWeight(
  synapse: Synapse,
  success: boolean,
  latencyMs: number,
  learningRate: number,
): Synapse {
  const reward = success ? 1.0 : -0.5;
  const latencyPenalty = Math.min(latencyMs / 30000, 0.3); // penalize slow responses
  const signal = reward - latencyPenalty;

  // Exponential moving average
  const newWeight = synapse.weight + learningRate * (signal - synapse.weight);

  return {
    ...synapse,
    weight: Math.max(0.01, Math.min(1.0, newWeight)), // clamp to [0.01, 1.0]
    activationCount: synapse.activationCount + 1,
    successCount: synapse.successCount + (success ? 1 : 0),
    failureCount: synapse.failureCount + (success ? 0 : 1),
    avgLatencyMs:
      (synapse.avgLatencyMs * synapse.activationCount + latencyMs) / (synapse.activationCount + 1),
    lastActivated: Date.now(),
    lastUpdated: Date.now(),
  };
}
```

---

## 6. Layer 3: Growth Pulse

### 6.1 Purpose

A system-wide heartbeat that drives continuous growth. Aligned with memory-core's Dreaming phases (light/REM/deep) but extended to cover all modules, not just memory.

### 6.2 Growth Cycles

```
  Hourly (Light)          Daily (REM)            Weekly (Deep)
  +----------------+     +------------------+    +--------------------+
  | Quick weight   |     | Pattern extract  |    | Structural reorg   |
  | micro-adjust   |     | from accumulated |    | Prune dead paths   |
  | from recent    |     | records          |    | Consolidate weights|
  | outcomes       |     | Skill embryo     |    | DNA integrity check|
  |                |     | incubation       |    | Immune system scan |
  | Touch: weights |     | Touch: patterns, |    | Touch: topology,   |
  |                |     | skill candidates |    | cell health, DNA   |
  +----------------+     +------------------+    +--------------------+
```

### 6.3 File Structure

```
extensions/growth-pulse/
  openclaw.plugin.json
  package.json
  api.ts
  index.ts
  src/
    pulse.ts                  # Main heartbeat orchestrator
    light-cycle.ts            # Hourly: weight micro-adjustment
    rem-cycle.ts              # Daily: pattern extraction, skill embryo
    deep-cycle.ts             # Weekly: structural reorg, pruning
    metrics.ts                # Growth metrics collection and reporting
    types.ts                  # Type definitions
```

### 6.4 Manifest

```json
{
  "id": "growth-pulse",
  "activation": { "onStartup": true },
  "contracts": {
    "tools": ["growth_metrics", "growth_status"]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean", "default": true },
      "lightIntervalMs": {
        "type": "number",
        "default": 3600000,
        "description": "Light cycle interval (default: 1 hour)"
      },
      "remIntervalMs": {
        "type": "number",
        "default": 86400000,
        "description": "REM cycle interval (default: 24 hours)"
      },
      "deepIntervalMs": {
        "type": "number",
        "default": 604800000,
        "description": "Deep cycle interval (default: 7 days)"
      },
      "pruneThreshold": {
        "type": "number",
        "default": 0.05,
        "description": "Paths with weight below this are pruned in deep cycle"
      },
      "skillEmbryoThreshold": {
        "type": "number",
        "default": 5,
        "description": "Repeated patterns needed before incubating a skill embryo"
      }
    }
  }
}
```

### 6.5 Growth Pulse Entry Point

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "growth-pulse",
  name: "Growth Pulse",
  description: "System-wide growth heartbeat driving continuous evolution across all layers.",

  register(api) {
    // Initialize growth pulse on gateway start
    api.on("gateway_start", async () => {
      const { initGrowthPulse } = await import("./src/pulse.js");
      await initGrowthPulse(api);
    });

    // Contribute growth context to heartbeat prompts
    api.on("heartbeat_prompt_contribution", async (event, ctx) => {
      const { contributeGrowthContext } = await import("./src/pulse.js");
      return contributeGrowthContext(api, event, ctx);
    });

    // Clean up on gateway stop
    api.on("gateway_stop", async () => {
      const { stopGrowthPulse } = await import("./src/pulse.js");
      await stopGrowthPulse(api);
    });

    // Register growth tools
    api.registerTool({
      name: "growth_metrics",
      description: "View growth metrics across all evolution layers",
      handler: async (params) => {
        const { getGrowthMetrics } = await import("./src/metrics.js");
        return getGrowthMetrics(api, params);
      },
    });

    api.registerTool({
      name: "growth_status",
      description: "Current growth pulse status and next cycle times",
      handler: async () => {
        const { getGrowthStatus } = await import("./src/pulse.js");
        return getGrowthStatus(api);
      },
    });
  },
});
```

### 6.6 Growth Metrics

```typescript
// src/types.ts

export type GrowthMetrics = {
  version: 1;
  measuredAt: number;

  // Perception growth: understanding intent better over time
  perception: {
    intentAccuracy: number; // % of first-try correct interpretations
    contextRelevance: number; // % of injected context that was useful
    trend: "growing" | "stable" | "declining";
  };

  // Routing growth: selecting better paths over time
  routing: {
    avgPathWeight: number;
    explorationRate: number;
    pruneCount: number;
    newSynapseCount: number;
    trend: "growing" | "stable" | "declining";
  };

  // Skill growth: accumulating effective capabilities
  skill: {
    activeSkills: number;
    embryoSkills: number;
    prunedSkills: number;
    avgSkillEffectiveness: number;
    trend: "growing" | "stable" | "declining";
  };

  // Judgment growth: evaluating outcomes better over time
  judgment: {
    predictionAccuracy: number; // % of correct outcome predictions
    falsePositiveRate: number;
    falseNegativeRate: number;
    trend: "growing" | "stable" | "declining";
  };

  // Structural growth: reorganizing itself effectively
  structural: {
    topologyChanges: number;
    cellHealth: number;
    dnaIntegrity: number;
    trend: "growing" | "stable" | "declining";
  };
};
```

---

## 7. Layer 4: Organic Cells

### 7.1 Purpose

Transform the system from a machine (dead parts assembled) into an organism (living cells with metabolism, immune response, endocrine regulation, DNA self-repair).

### 7.2 Biological Mapping

```
+--Human Body-----------+  +--OpenClaw Organism------------------+
|                        |  |                                     |
|  Cells                 |  |  Each extension = one living cell   |
|  Blood circulation     |  |  Hook event flow = bloodstream      |
|  Nervous system        |  |  Neural Router (Layer 2) = nerves   |
|  Immune system         |  |  before_tool_call block = antibody  |
|  Endocrine system      |  |  Global state hormones = endocrine  |
|  Stem cells            |  |  Skill embryos in skills/ = stem    |
|  DNA                   |  |  Plugin manifest checksum = genome  |
|  Metabolism             |  |  Input/output/waste tracking = meta |
|  Apoptosis (cell death)|  |  Weight below threshold = apoptosis |
|                        |  |                                     |
+------------------------+  +-------------------------------------+
```

### 7.3 File Structure

```
extensions/organic-cells/
  openclaw.plugin.json
  package.json
  api.ts
  index.ts
  src/
    cell-registry.ts          # Cell health tracking for each extension
    metabolism.ts             # Input/output/waste accounting
    immune.ts                 # Anomaly detection and isolation
    endocrine.ts              # Global state hormones (busy/idle/stress/repair)
    stem-pool.ts              # Skill embryo management
    dna-check.ts              # Manifest integrity verification
    types.ts                  # Type definitions
```

### 7.4 Cell Health Model

```typescript
// src/types.ts

export type CellState = "healthy" | "stressed" | "recovering" | "dormant" | "apoptotic";

export type CellHealth = {
  extensionId: string;
  state: CellState;
  health: number; // 0.0 - 1.0

  // Metabolism
  metabolism: {
    inputCount: number; // How many times invoked
    outputCount: number; // How many successful outputs
    wasteCount: number; // Errors, timeouts, retries
    efficiency: number; // output / input ratio
  };

  // Vitals
  avgLatencyMs: number;
  errorRate: number;
  lastActive: number;
  uptime: number;

  // DNA
  manifestChecksum: string;
  dnaIntact: boolean;
  lastDnaCheck: number;
};

export type OrganismState = "active" | "idle" | "stressed" | "repair" | "growth";

export type Hormone = {
  type: "cortisol" | "growth" | "melatonin" | "adrenaline";
  level: number; // 0.0 - 1.0
  trigger: string;
  timestamp: number;
};

// cortisol = system under stress (high error rates)
// growth = system in growth mode (learning active, low errors)
// melatonin = system idle (low activity, good time for deep cycle)
// adrenaline = system under high load (defer non-essential work)
```

### 7.5 Immune System Logic

```typescript
// src/immune.ts

export type ThreatPattern = {
  id: string;
  type: "repeated-failure" | "latency-spike" | "resource-leak" | "anomalous-pattern";
  source: string;
  severity: "low" | "medium" | "high" | "critical";
  firstDetected: number;
  occurrences: number;
  quarantined: boolean;
};

// Uses before_tool_call hook to quarantine suspicious tool calls
export function evaluateThreat(
  event: PluginHookBeforeToolCallEvent,
  cellHealth: CellHealth,
  history: LearningRecord[],
): { block: boolean; blockReason?: string } {
  // High error rate on this tool recently
  if (cellHealth.errorRate > 0.8 && cellHealth.metabolism.inputCount > 10) {
    return {
      block: true,
      blockReason: `Immune system: ${event.toolName} quarantined (${Math.round(cellHealth.errorRate * 100)}% error rate)`,
    };
  }

  return { block: false };
}
```

### 7.6 Endocrine System

```typescript
// src/endocrine.ts

export function evaluateOrganismState(
  cells: CellHealth[],
  recentRecords: LearningRecord[],
): { state: OrganismState; hormones: Hormone[] } {
  const avgHealth = cells.reduce((sum, c) => sum + c.health, 0) / cells.length;
  const avgErrorRate = cells.reduce((sum, c) => sum + c.errorRate, 0) / cells.length;
  const recentActivity = recentRecords.filter((r) => Date.now() - r.timestamp < 300000).length;

  const hormones: Hormone[] = [];

  if (avgErrorRate > 0.5) {
    hormones.push({
      type: "cortisol",
      level: avgErrorRate,
      trigger: "high-error-rate",
      timestamp: Date.now(),
    });
  }

  if (recentActivity < 2 && avgHealth > 0.8) {
    hormones.push({
      type: "melatonin",
      level: 0.8,
      trigger: "idle-healthy",
      timestamp: Date.now(),
    });
  }

  if (recentActivity > 20) {
    hormones.push({
      type: "adrenaline",
      level: Math.min(recentActivity / 30, 1.0),
      trigger: "high-load",
      timestamp: Date.now(),
    });
  }

  if (avgHealth > 0.7 && avgErrorRate < 0.2) {
    hormones.push({
      type: "growth",
      level: avgHealth,
      trigger: "healthy-low-errors",
      timestamp: Date.now(),
    });
  }

  // Determine organism state from hormone balance
  const dominantHormone = hormones.reduce((a, b) => (a.level > b.level ? a : b), hormones[0]);

  const stateMap: Record<Hormone["type"], OrganismState> = {
    cortisol: "stressed",
    growth: "growth",
    melatonin: "idle",
    adrenaline: "active",
  };

  return {
    state: dominantHormone ? stateMap[dominantHormone.type] : "idle",
    hormones,
  };
}
```

---

## 8. Implementation Schedule

### 8.1 Phase Plan

| Phase | Extension              | Duration  | Dependencies               | Risk                             |
| ----- | ---------------------- | --------- | -------------------------- | -------------------------------- |
| 1     | `operational-learning` | 1-2 weeks | None (uses existing hooks) | Low: pure additive               |
| 2     | `neural-router`        | 2-3 weeks | Phase 1 learning data      | Medium: touches model resolution |
| 3     | `growth-pulse`         | 1-2 weeks | Phase 1 + 2                | Low: cron-based, additive        |
| 4     | `organic-cells`        | 3-4 weeks | Phase 1 + 2 + 3 validated  | Medium: comprehensive monitoring |

### 8.2 Validation Gates

Each phase must pass before proceeding:

**Phase 1 Gate:**

- [ ] Learning records are being collected from all four hooks
- [ ] Pattern analyzer produces meaningful patterns
- [ ] `before_prompt_build` injection improves response quality (A/B test)
- [ ] Zero performance impact on normal operations
- [ ] `pnpm check:changed` passes

**Phase 2 Gate:**

- [ ] Weight matrix updates correctly from Phase 1 data
- [ ] `before_model_resolve` correctly overrides model selection
- [ ] Competitive activation selects better paths than random
- [ ] Exploration rate produces new discoveries
- [ ] Fallback to default routing works when neural router is disabled

**Phase 3 Gate:**

- [ ] Light cycle runs hourly without blocking
- [ ] REM cycle extracts meaningful patterns
- [ ] Deep cycle prunes dead paths without removing useful ones
- [ ] Growth metrics show positive trends
- [ ] Aligned with memory-core Dreaming phases (no conflicts)

**Phase 4 Gate:**

- [ ] Cell health tracking covers all active extensions
- [ ] Immune system blocks genuinely problematic patterns
- [ ] Immune system does NOT block legitimate operations (false positive rate < 1%)
- [ ] Endocrine system correctly identifies organism state
- [ ] DNA integrity checks pass for all extensions

### 8.3 Rollback Strategy

Every phase is independently disableable:

```json
// openclaw.json
{
  "plugins": {
    "entries": {
      "operational-learning": { "enabled": false },
      "neural-router": { "enabled": false },
      "growth-pulse": { "enabled": false },
      "organic-cells": { "enabled": false }
    }
  }
}
```

All hooks are fail-open by default. Disabling any extension causes the system to behave exactly as it does today.

---

## 9. Architecture Compliance Checklist

| Rule                                                         | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
| ------------------------------------------------------------ | ------- | ------- | ------- | ------- |
| Only import from `openclaw/plugin-sdk/*`                     | Yes     | Yes     | Yes     | Yes     |
| Never modify `src/**`                                        | Yes     | Yes     | Yes     | Yes     |
| Manifest-first capability declaration                        | Yes     | Yes     | Yes     | Yes     |
| Hook-based integration only                                  | Yes     | Yes     | Yes     | Yes     |
| Lazy loading for expensive operations                        | Yes     | Yes     | Yes     | Yes     |
| Plugin state store for persistence                           | Yes     | Yes     | Yes     | Yes     |
| No cross-extension `src/` imports                            | Yes     | Yes     | Yes     | Yes     |
| Backwards-compatible (third-party plugins unaffected)        | Yes     | Yes     | Yes     | Yes     |
| Fail-open (disabling = zero behavior change)                 | Yes     | Yes     | Yes     | Yes     |
| Config via `configSchema` with `additionalProperties: false` | Yes     | Yes     | Yes     | Yes     |
| `definePluginEntry` entry point                              | Yes     | Yes     | Yes     | Yes     |

---

## 10. Summary

### What We're Building

A four-layer evolution stack that transforms OpenClaw from a static machine into a living organism:

```
Layer 4: Organic Cells     = Body (cells, immune, endocrine, DNA)
Layer 3: Growth Pulse      = Heartbeat (drives continuous growth)
Layer 2: Neural Router     = Nervous System (dynamic synaptic routing)
Layer 1: Operational Learn = Senses (every operation feeds back)
```

### How We're Building It

- **4 independent extensions** under `extensions/`
- **Zero core modifications** — all integration via official hooks
- **Each phase independently valuable** — Phase 1 alone is useful
- **Each phase independently disableable** — config toggle, fail-open
- **100% compliant** with OpenClaw plugin architecture rules

### What Changes for Existing Users

**Nothing.** All four extensions are opt-in, fail-open, and backwards-compatible. The system behaves exactly as it does today unless these extensions are explicitly enabled.
