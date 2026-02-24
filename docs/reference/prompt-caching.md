---
title: "Prompt Caching"
summary: "Prompt caching knobs, merge order, provider behavior, and tuning patterns"
read_when:
  - You want to reduce prompt token costs with cache retention
  - You need per-agent cache behavior in multi-agent setups
  - You are tuning heartbeat and cache-ttl pruning together
---

# Prompt caching

Prompt caching means the model provider can reuse unchanged prompt prefixes (usually system/developer instructions and other stable context) across turns instead of re-processing them every time. The first matching request writes cache tokens (`cacheWrite`), and later matching requests can read them back (`cacheRead`).

Why this matters: lower token cost, faster responses, and more predictable performance for long-running sessions. Without caching, repeated prompts pay the full prompt cost on every turn even when most input did not change.

This page covers all cache-related knobs that affect prompt reuse and token cost.

For Anthropic pricing details, see:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

## Primary knobs

### `cacheRetention` (model and per-agent)

Set cache retention on model params:

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "short" # none | short | long
```

Per-agent override:

```yaml
agents:
  list:
    - id: "alerts"
      params:
        cacheRetention: "none"
```

Config merge order:

1. `agents.defaults.models["provider/model"].params`
2. `agents.list[].params` (matching agent id; overrides by key)

### Legacy `cacheControlTtl`

Legacy values are still accepted and mapped:

- `5m` -> `short`
- `1h` -> `long`

Prefer `cacheRetention` for new config.

### `contextPruning.mode: "cache-ttl"`

Prunes old tool-result context after cache TTL windows so post-idle requests do not re-cache oversized history.

```yaml
agents:
  defaults:
    contextPruning:
      mode: "cache-ttl"
      ttl: "1h"
```

See [Session Pruning](/concepts/session-pruning) for full behavior.

### Heartbeat keep-warm

Heartbeat can keep cache windows warm and reduce repeated cache writes after idle gaps.

```yaml
agents:
  defaults:
    heartbeat:
      every: "55m"
```

Per-agent heartbeat is supported at `agents.list[].heartbeat`.

## Provider behavior

### Anthropic (direct API)

- `cacheRetention` is supported.
- With Anthropic API-key auth profiles, OpenClaw seeds `cacheRetention: "short"` for Anthropic model refs when unset.

### Amazon Bedrock

- Anthropic Claude model refs (`amazon-bedrock/*anthropic.claude*`) support explicit `cacheRetention` pass-through.
- Non-Anthropic Bedrock models are forced to `cacheRetention: "none"` at runtime.

### OpenRouter Anthropic models

For `openrouter/anthropic/*` model refs, OpenClaw injects Anthropic `cache_control` on system/developer prompt blocks to improve prompt-cache reuse.

### Other providers

If the provider does not support this cache mode, `cacheRetention` has no effect.

## Tuning patterns

### Mixed traffic (recommended default)

Keep a long-lived baseline on your main agent, disable caching on bursty notifier agents:

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
  list:
    - id: "research"
      default: true
      heartbeat:
        every: "55m"
    - id: "alerts"
      params:
        cacheRetention: "none"
```

### Cost-first baseline

- Set baseline `cacheRetention: "short"`.
- Enable `contextPruning.mode: "cache-ttl"`.
- Keep heartbeat below your TTL only for agents that benefit from warm caches.

## Cache diagnostics

OpenClaw exposes dedicated cache-trace diagnostics for embedded agent runs.

### `diagnostics.cacheTrace` config

```yaml
diagnostics:
  cacheTrace:
    enabled: true
    filePath: "~/.openclaw/logs/cache-trace.jsonl" # optional
    includeMessages: false # default true
    includePrompt: false # default true
    includeSystem: false # default true
```

Defaults:

- `filePath`: `$OPENCLAW_STATE_DIR/logs/cache-trace.jsonl`
- `includeMessages`: `true`
- `includePrompt`: `true`
- `includeSystem`: `true`

### Env toggles (one-off debugging)

- `OPENCLAW_CACHE_TRACE=1` enables cache tracing.
- `OPENCLAW_CACHE_TRACE_FILE=/path/to/cache-trace.jsonl` overrides output path.
- `OPENCLAW_CACHE_TRACE_MESSAGES=0|1` toggles full message payload capture.
- `OPENCLAW_CACHE_TRACE_PROMPT=0|1` toggles prompt text capture.
- `OPENCLAW_CACHE_TRACE_SYSTEM=0|1` toggles system prompt capture.

### What to inspect

- Cache trace events are JSONL and include staged snapshots like `session:loaded`, `prompt:before`, `stream:context`, and `session:after`.
- Per-turn cache token impact is visible in normal usage surfaces via `cacheRead` and `cacheWrite` (for example `/usage full` and session usage summaries).

## Quick troubleshooting

- High `cacheWrite` on most turns: check for volatile system-prompt inputs and verify model/provider supports your cache settings.
- No effect from `cacheRetention`: confirm model key matches `agents.defaults.models["provider/model"]`.
- Bedrock Nova/Mistral requests with cache settings: expected runtime force to `none`.

Related docs:

- [Anthropic](/providers/anthropic)
- [Token Use and Costs](/reference/token-use)
- [Session Pruning](/concepts/session-pruning)
- [Gateway Configuration Reference](/gateway/configuration-reference)
