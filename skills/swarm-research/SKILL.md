---
name: swarm-research
description: >
  Leverages Kimi K2.5 Agent Swarm for parallel research, data gathering,
  and bulk processing tasks. Achieves 4.5x speed improvement through
  PARL-trained parallel agent orchestration with up to 100 sub-agents.
metadata: { "openclaw": { "emoji": "🐝" } }
---

# Swarm Research

Parallel research execution via Kimi K2.5 Agent Swarm.

## When to Use

- Multi-source research (gathering info from 5+ sources)
- Competitive analysis across multiple entities
- Bulk data processing or classification
- Web-scale information gathering
- Any task decomposable into 3+ independent sub-tasks
- Latency-sensitive parallel workloads

## Activation

- **Criteria-triggered:** Task decomposable into ≥3 independent sub-tasks
- **Manual:** "swarm this", "parallel research", "bulk process"

## Architecture

```
OPUS (Planner)
  │
  ├─ Decomposes task into N independent sub-tasks
  ├─ Defines success criteria per sub-task
  └─ Generates structured task manifest
       │
       ▼
KIMI K2.5 (Agent Swarm Orchestrator)
  │
  ├─ Sub-Agent 1 ──→ Task A ──→ Result A
  ├─ Sub-Agent 2 ──→ Task B ──→ Result B
  ├─ Sub-Agent 3 ──→ Task C ──→ Result C
  ├─ ...
  └─ Sub-Agent N ──→ Task N ──→ Result N
       │
       ▼
OPUS (Synthesiser)
  │
  └─ Merges results, resolves conflicts,
     produces final output
```

## Procedure

### Step 1: Opus Plans the Decomposition

```
Decompose this research task into independent, parallelisable sub-tasks.

Task: {task_description}

For each sub-task, provide:
- sub_task_id: sequential number
- description: what to research/process
- search_terms: suggested queries
- success_criteria: how to know it's complete
- output_format: expected structure

Aim for 5-20 sub-tasks. Each must be INDEPENDENTLY completable.
Do NOT create dependencies between sub-tasks.
```

### Step 2: Kimi Swarm Executes

Spawn Kimi with the full task manifest:

```bash
sessions_spawn(
  model="kimi/kimi-k2.5",
  task="Execute these {N} research sub-tasks in parallel using Agent Swarm mode.
        Task manifest: {manifest_json}
        Return results as structured JSON array.",
  label="swarm-exec"
)
```

### Step 3: Opus Synthesises

```
You received results from {N} parallel research agents.
Original task: {task_description}

Results:
{swarm_results}

Instructions:
1. Merge all results into a coherent output
2. Resolve any contradictions between agents
3. Flag gaps (sub-tasks that failed or returned incomplete data)
4. Produce the final deliverable in the requested format
5. Quality assessment: what % of the task was successfully completed?
```

## Error Handling

- **Sub-agent failure:** Kimi Swarm handles internally. Opus checks for gaps post-synthesis.
- **Kimi Swarm unavailable:** Fall back to sequential sessions_spawn with Kimi (standard mode)
- **Partial completion:** Opus synthesises from whatever completed. Gaps flagged explicitly.
- **Swarm timeout (>300s):** Kill and collect partial results
- **Quality below threshold:** Opus identifies failed sub-tasks, re-spawns them individually

## Performance Expectations

- **Speed:** 3-4.5× faster than sequential execution (per Moonshot benchmarks)
- **Scale:** Up to 100 sub-agents, 1,500 tool calls
- **Best for:** Tasks with high decomposability and low inter-task dependency

## Forensic Logging

Each swarm invocation logs to `memory/swarm-log.jsonl`:

```json
{
  "id": "uuid",
  "timestamp": "ISO-8601",
  "task_hash": "sha256",
  "sub_tasks_planned": 15,
  "sub_tasks_completed": 14,
  "sub_tasks_failed": 1,
  "execution_time_ms": 45000,
  "speedup_vs_sequential": 3.2,
  "opus_quality_score": 0.93
}
```
