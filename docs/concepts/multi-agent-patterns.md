---
title: "Multi-Agent Orchestration Patterns"
summary: "Practical patterns, communication models, and best practices for building multi-agent systems with OpenClaw"
read_when:
  - You need to coordinate multiple agents
  - You want to understand agent communication patterns
  - You are building a team of specialized agents
  - You need to optimize multi-agent token costs
---

# Multi-Agent Orchestration Patterns

This guide covers practical patterns for building multi-agent systems with OpenClaw, from simple delegation to complex swarm architectures.

For the basics, see [Multi-Agent](/concepts/multi-agent).

## Core Primitives

OpenClaw provides three primitives for multi-agent coordination:

| Primitive | Tool | Use Case |
|-----------|------|----------|
| **Spawn** | `sessions_spawn` | Create a new agent session (one-shot or persistent) |
| **Send** | `sessions_send` | Send a message to an existing session |
| **Manage** | `subagents` | List, steer, or kill running sub-agents |

### sessions_spawn

```json5
// One-shot task (fire-and-forget)
sessions_spawn({
  task: "Analyze this log file and summarize errors",
  mode: "run",
  runTimeoutSeconds: 120
})

// Persistent session (long-running)
sessions_spawn({
  task: "You are a code reviewer. Wait for code submissions.",
  mode: "session",
  label: "code-reviewer"
})
```

### sessions_send

```json5
// Send to a labeled session
sessions_send({
  label: "code-reviewer",
  message: "Please review this PR: ..."
})

// Send to a specific session key
sessions_send({
  sessionKey: "agent:main:subagent:abc-123",
  message: "Update on the task..."
})
```

## Orchestration Models

### 1. Hub-and-Spoke (Coordinator + Workers)

The most common pattern. One coordinator agent delegates tasks to specialized workers.

```
        ┌─── Worker A (Research)
        │
Coordinator ─── Worker B (Coding)
        │
        └─── Worker C (Review)
```

**When to use:**
- Tasks can be cleanly decomposed
- Workers don't need to communicate with each other
- You need centralized progress tracking

**Implementation:**

```json5
// Coordinator spawns workers
const workers = [
  sessions_spawn({ label: "researcher", task: "Research X", mode: "run" }),
  sessions_spawn({ label: "coder", task: "Implement Y", mode: "run" }),
  sessions_spawn({ label: "reviewer", task: "Review Z", mode: "run" }),
]
// Wait for all completions (push-based auto-announce)
// Then synthesize results
```

**Key lesson:** Workers cannot spawn their own sub-agents (nesting depth = 1). The coordinator must handle all spawning.

### 2. Pipeline (Sequential Processing)

Each agent processes and passes results to the next stage.

```
Input → Agent A (Extract) → Agent B (Transform) → Agent C (Load) → Output
```

**When to use:**
- Processing has clear sequential stages
- Each stage transforms the output
- You need quality gates between stages

**Implementation:**

```json5
// Stage 1: Extract
const extracted = await sessions_spawn({
  task: "Extract key data from this document: ...",
  mode: "run"
})

// Stage 2: Transform (uses Stage 1 output)
const transformed = await sessions_spawn({
  task: `Transform this extracted data: ${extracted}`,
  mode: "run"
})

// Stage 3: Load
sessions_spawn({
  task: `Write this to the database: ${transformed}`,
  mode: "run"
})
```

### 3. Map-Reduce (Parallel Processing + Aggregation)

Split work across parallel workers, then combine results.

```
         ┌─── Worker 1 (chunk 1)
         │
Input ───┼─── Worker 2 (chunk 2) ───→ Aggregator → Output
         │
         └─── Worker 3 (chunk 3)
```

**When to use:**
- Large tasks that can be parallelized
- Each chunk is independent
- Final result needs synthesis

**Constraints:** Maximum 5 concurrent sub-agents per session.

### 4. Expert Panel (Multiple Perspectives)

Multiple agents analyze the same input from different angles.

```
              ┌─── Expert A (Technical)
              │
Same Input ───┼─── Expert B (Business) ───→ Synthesizer
              │
              └─── Expert C (Security)
```

**When to use:**
- Complex decisions needing multiple viewpoints
- Risk assessment with different lenses
- Research with interdisciplinary angles

## Token and Cost Management

### The "Brain vs Hands" Model

A key optimization: **use the coordinator for information gathering, sub-agents for analysis only**.

| Layer | Who | What |
|-------|-----|------|
| **Information** (Hands) | Coordinator | File reading, API calls, data collection |
| **Analysis** (Brain) | Sub-agents | Reasoning, writing, decision-making |

**Why:** Sub-agents receive full system prompts (~5-10K tokens each). Sending them to gather information wastes those tokens on setup. Instead, pre-digest information and send it as compact context.

```json5
// ❌ Bad: Sub-agent wastes tokens on data gathering
sessions_spawn({
  task: "Read all files in /src/ and find bugs"
})

// ✅ Good: Coordinator gathers, sub-agent analyzes  
const fileContents = exec("cat /src/main.ts")
sessions_spawn({
  task: `Analyze this code for bugs:\n${fileContents}`
})
```

### Token Budget Estimation

| Component | Tokens (approx) |
|-----------|-----------------|
| Sub-agent system prompt | 5,000-10,000 |
| Task description | 500-2,000 |
| Sub-agent thinking + response | 1,000-5,000 |
| **Total per sub-agent** | **6,500-17,000** |

For a 5-agent team running one task each: ~50,000-85,000 tokens.

### Optimization Strategies

1. **Batch similar tasks** — One agent doing 3 related analyses beats 3 agents doing 1 each
2. **Pre-digest context** — Send summaries, not raw data
3. **Use `mode: "run"`** — One-shot tasks clean up automatically
4. **Set timeouts** — Prevent runaway token consumption
5. **Label sessions** — Reuse persistent sessions instead of spawning new ones

## Practical Examples

### Research Team

```
Coordinator (you)
├── Researcher: "Find papers on topic X, summarize top 5"
├── Analyst: "Given these papers, identify key trends"  
└── Writer: "Draft a report based on these trends"
```

### Code Review Pipeline

```
Coordinator (you)
├── Scanner: "Find potential issues in this diff"
├── Reviewer: "Given these issues, assess severity and suggest fixes"
└── Documenter: "Write a review summary"
```

### Content Pipeline

```
Coordinator (you)
├── Researcher: "Gather facts about topic X"
├── Drafter: "Write a first draft using these facts"
├── Editor: "Polish this draft for clarity and accuracy"
└── Translator: "Translate the final version to zh-CN"
```

## Common Pitfalls

### 1. Over-Decomposition

**Problem:** Splitting simple tasks across multiple agents when one could handle it.

**Rule of thumb:** If a task takes < 2 minutes for one agent, don't split it.

### 2. Timeout Mismanagement

**Problem:** Sub-agents timing out on large tasks.

**Fix:** Set `runTimeoutSeconds` appropriately. Default is often too short for complex tasks.

### 3. Context Loss Between Agents

**Problem:** Important context doesn't survive the coordinator → sub-agent handoff.

**Fix:** Be explicit in task descriptions. Include all necessary context inline.

### 4. Ignoring Concurrency Limits

**Problem:** Trying to spawn more than 5 concurrent sub-agents.

**Fix:** Batch spawns in groups of 5. Wait for completions before spawning more.

### 5. Nesting Depth Violations

**Problem:** Sub-agents trying to spawn their own sub-agents.

**Current limitation:** Sub-agents need explicit `sessions_spawn` permission via `tools.subagents.tools.alsoAllow`. Even with permission, deep nesting is discouraged — prefer flat hierarchies.

## Further Reading

- [Multi-Agent (basics)](/concepts/multi-agent)
- [Session Management](/reference/session-management-compaction)
- [ACP Agents](/tools/acp-agents)
