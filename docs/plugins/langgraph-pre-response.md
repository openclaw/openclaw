---
title: LangGraph Pre-Response Plugin
description: Automatically enrich agent context before responses using LangGraph
---

# LangGraph Pre-Response Plugin

The `langgraph-pre-response` plugin uses OpenClaw's `before_agent_start` hook to intelligently gather relevant context before each agent response.

## Features

- **Intent Detection**: Uses AI to understand what the user is asking about
- **Smart Tool Routing**: Only runs tools relevant to the query
- **Parallel Execution**: Fast context gathering (typically 0.5-2s)
- **Graceful Fallback**: Falls back to normal response if planner fails

## Installation

```bash
openclaw plugin install langgraph-pre-response
```

## Configuration

Add to `~/.openclaw/config.yaml`:

```yaml
plugins:
  langgraph-pre-response:
    enabled: true
    plannerPath: scripts/langgraph_planner_v4.py
    timeoutMs: 5000
```

## How It Works

1. User sends a message
2. `before_agent_start` hook fires
3. Plugin spawns LangGraph planner subprocess
4. Planner detects intent and routes to relevant tools
5. Results are formatted and returned as `prependContext`
6. Context is prepended to user's message
7. LLM generates response with enriched context

## Requirements

- Python 3.8+
- `langgraph` Python package
- A LangGraph planner script (example provided)

## Writing a Custom Planner

Your planner must:
1. Accept the query as CLI argument
2. Output JSON to `/tmp/pre_response_results_v4.json`
3. Complete within the configured timeout

See the [example planner](https://github.com/openclaw/openclaw/tree/main/extensions/langgraph-pre-response/README.md) for reference.

## See Also

- [Plugin Development Guide](/docs/plugins/development)
- [Hook System Reference](/docs/reference/hooks)
