---
title: Model Spawn
description: Spawn one or more model instances for inference tasks — in-place session switch or isolated ephemeral runs.
---

# `model_spawn` Tool Specification

**Version**: 1.0  
**Tool name**: `model_spawn`  
**Implemented in**: OpenClaw (TypeScript), zeroclaw (Rust, in design)

---

## Overview

`model_spawn` gives the LLM direct control over model selection at inference time. It has two modes:

| Mode    | What it does                                         | Context                                        |
| ------- | ---------------------------------------------------- | ---------------------------------------------- |
| `live`  | Switch the current session to a different model      | Preserved — prior conversation carries forward |
| `spawn` | Run one or more tasks in isolated ephemeral sessions | Isolated — each spawn gets a clean context     |

`spawn` mode supports both **single-model delegation** (route a task to the best model for it) and **parallel multi-model execution** (send the same or different tasks to multiple models concurrently, for specialization or comparison).

---

## Schema (canonical)

```json
{
  "name": "model_spawn",
  "parameters": {
    "type": "object",
    "required": ["mode"],
    "properties": {
      "mode": {
        "type": "string",
        "enum": ["live", "spawn"],
        "description": "live=in-place session model switch (context preserved). spawn=isolated ephemeral run(s)."
      },
      "model": {
        "type": "string",
        "description": "Full provider/model spec, e.g. \"together/MiniMaxAI/MiniMax-M2.7\". Required for live mode and single-model spawn."
      },
      "task": {
        "type": "string",
        "description": "Task prompt. Required for single spawn. Serves as default for spawns[] entries that omit their own task."
      },
      "context": {
        "type": "string",
        "description": "Context prepended to task. Used for single spawn or as default for spawns[] entries."
      },
      "spawns": {
        "type": "array",
        "maxItems": 5,
        "description": "Multi-model parallel execution. Each entry runs in its own isolated session concurrently.",
        "items": {
          "type": "object",
          "required": ["model"],
          "properties": {
            "model": { "type": "string", "description": "Model for this spawn." },
            "task": {
              "type": "string",
              "description": "Task for this spawn. Falls back to top-level task."
            },
            "label": { "type": "string", "description": "Human label for this spawn's result." },
            "context": {
              "type": "string",
              "description": "Context for this spawn. Falls back to top-level context."
            }
          }
        }
      },
      "cleanup": {
        "type": "string",
        "enum": ["delete", "keep"],
        "description": "Session cleanup after spawn. Default: \"delete\" (ephemeral)."
      },
      "timeout_seconds": {
        "type": "number",
        "minimum": 0,
        "description": "Per-spawn run timeout in seconds."
      }
    }
  }
}
```

**Mutual exclusion**: `model` (top-level) and `spawns[]` are mutually exclusive. Use one or the other in `spawn` mode, not both.

---

## Response schema (canonical)

### `live` mode

```json
{
  "status":       "ok" | "error",
  "mode":         "live",
  "model":        "provider/model-id",
  "provider":     "provider",
  "modelId":      "model-id",
  "switchPending": true,
  "note":         "human-readable status"
}
```

### `spawn` mode — single

```json
{
  "mode":   "spawn",
  "multi":  false,
  "model":  "provider/model-id",
  "status": "accepted" | "error",
  ...spawnSubagentResult
}
```

### `spawn` mode — multi

```json
{
  "mode":    "spawn",
  "multi":   true,
  "count":   3,
  "results": [
    {
      "label":  "MiniMax summary",
      "index":  0,
      "model":  "together/MiniMaxAI/MiniMax-M2.7",
      "status": "accepted",
      ...
    },
    { "label": "Kimi reasoning", "index": 1, ... },
    { "label": "GLM analysis",   "index": 2, ... }
  ]
}
```

---

## Usage examples

### Live switch (context preserved)

```json
{
  "mode": "live",
  "model": "together/zai-org/GLM-5"
}
```

Switch to GLM-5 for the remainder of this session. Prior conversation is not affected.

---

### Single spawn (task delegation)

```json
{
  "mode": "spawn",
  "model": "together/MiniMaxAI/MiniMax-M2.7",
  "task": "Summarize the Q1 2026 10-K executive section in 200 words.",
  "cleanup": "delete"
}
```

Run a single task on MiniMax. The parent session's model is unchanged.

---

### Multi-model parallel specialization

Each model gets a different subtask it's best suited for:

```json
{
  "mode": "spawn",
  "spawns": [
    {
      "model": "together/MiniMaxAI/MiniMax-M2.7",
      "task": "Extract all numerical metrics from the following 10-K text: ...",
      "label": "metric-extraction"
    },
    {
      "model": "together/zai-org/GLM-5",
      "task": "Identify regulatory risk factors and rate severity 1-5: ...",
      "label": "risk-analysis"
    },
    {
      "model": "groq/moonshotai/kimi-k2-instruct-0905",
      "task": "Compare this company's guidance to analyst consensus: ...",
      "label": "guidance-comparison"
    }
  ],
  "cleanup": "delete",
  "timeout_seconds": 120
}
```

All three spawns run concurrently. Results are collected and returned as `results[]`.

---

### Multi-model comparison (same task, different models)

```json
{
  "mode": "spawn",
  "task": "Write a one-paragraph investment thesis for NVDA based on Q1 2026 earnings.",
  "spawns": [
    { "model": "together/MiniMaxAI/MiniMax-M2.7", "label": "minimax" },
    { "model": "together/zai-org/GLM-5", "label": "glm5" },
    { "model": "xai/grok-4-1-fast", "label": "grok" }
  ]
}
```

Top-level `task` is shared across all entries. Results returned for comparison.

---

## Decision guide: when to use each mode

| Situation                                                                                                  | Recommended mode                                  |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| The current conversation would be better served by a different model going forward                         | `live`                                            |
| A single subtask needs a specialized model (e.g. a coding model for code gen, a reasoning model for logic) | `spawn` + single `model`                          |
| Multiple subtasks need different specialist models simultaneously                                          | `spawn` + `spawns[]`                              |
| A/B model comparison on the same prompt                                                                    | `spawn` + `spawns[]` with shared top-level `task` |
| You need the child session to persist after the run                                                        | `spawn` + `cleanup="keep"`                        |

---

## Implementation notes (conformant systems)

### `live` mode requirements

The system must:

1. Parse `model` as `<provider>/<model-id>` (split on first `/`)
2. Set a session-scoped model override that takes effect on the **next clean turn boundary**, not immediately mid-inference
3. Preserve full prior conversation context — the override applies to future turns only
4. **Not** persist the override to global config — it is session-scoped

### `spawn` mode requirements

The system must:

1. Create a new isolated session (no prior conversation context injected)
2. Use the specified model for that session's inference
3. Return when the task completes (or times out)
4. If `cleanup="delete"` (default), destroy the session record after completion
5. For `spawns[]`, run all entries **concurrently** (not sequentially) and collect results

### `spawns[]` fallback rules

- If a spawn entry omits `task`: use top-level `task`. Error if top-level `task` is also absent.
- If a spawn entry omits `context`: use top-level `context` (if any). No error if both are absent.
- If a spawn entry omits `label`: use the entry's `model` value as the label.

---

## Conformance across systems

| System   | `live` mode                                   | `spawn` single                                    | `spawn` multi               |
| -------- | --------------------------------------------- | ------------------------------------------------- | --------------------------- |
| OpenClaw | ✅ `liveModelSwitchPending` + session store   | ✅ `spawnSubagentDirect`                          | ✅ `Promise.all`            |
| zeroclaw | ✅ `MODEL_SWITCH_REQUEST` global + agent loop | ✅ `create_provider_with_options` + `simple_chat` | ✅ `futures_util::join_all` |

See `ZEROCLAW_MODEL_SPAWN_DESIGN.md` in the InvestorClaw repo for the zeroclaw implementation spec.
