---
summary: "Optimize Anthropic prompt caching to reduce costs"
title: "Anthropic Prompt Caching Optimization"
---

# Anthropic Prompt Caching Optimization

Anthropic models support prompt caching to reduce costs on repeated content. However, certain OpenClaw configurations can inadvertently break caching, causing **80-170x cost increases**.

## Understanding the Issue (#20894)

**Symptom:**

- Using Claude Opus as fallback model
- Expected: High `cache_read` tokens (reusing cached system prompt)
- Actual: High `cache_write` tokens on every turn
- Cost increase: $0.44/day → $84.32/day (measured)

**Root cause:**

Per-message volatile data (`message_id`, `reply_to_id`, `sender_id`) gets injected into the **system prompt** via `buildInboundMetaSystemPrompt()`. Since these values change every turn, Anthropic's prefix-based caching can't reuse the system prompt.

**Evidence:**

```
Expected cache behavior:
- Turn 1: cache_write=45,123 (full prompt cached)
- Turn 2: cache_read=45,123, cache_write=0 (reuse cache)
- Turn 3: cache_read=45,123, cache_write=0 (reuse cache)

Actual broken behavior:
- Turn 1: cache_write=45,123, cache_read=8,921
- Turn 2: cache_write=45,123, cache_read=8,921
- Turn 3: cache_write=45,123, cache_read=8,921

cache_read=8,921 represents only the static instruction prefix
before inbound metadata block. The rest is rewritten every turn.
```

## How to Check if You're Affected

### Method 1: Check Token Usage

```bash
# View recent agent runs
openclaw logs --follow | grep -E "cache_write|cache_read"

# Look for pattern:
# - High cache_write on every turn
# - Low constant cache_read (e.g., ~8,921 tokens)
```

**Healthy caching:**

```
turn 1: cache_write=45000, cache_read=0
turn 2: cache_write=0,     cache_read=45000
turn 3: cache_write=0,     cache_read=45000
```

**Broken caching (this issue):**

```
turn 1: cache_write=45000, cache_read=8921
turn 2: cache_write=45000, cache_read=8921
turn 3: cache_write=45000, cache_read=8921
```

### Method 2: Check Cost Trends

```bash
# Calculate daily Anthropic API cost
# cache_write tokens cost 5x more than cache_read

# If costs increased dramatically after OpenClaw update,
# you may be affected
```

### Method 3: Inspect System Prompt

Check if volatile data appears in system prompt:

```json
// In logs, look for system prompt containing:
{
  "role": "system",
  "content": "... message_id: 12345 ..." // ❌ Breaks caching!
}
```

## How to Fix

### Option 1: Move Metadata to User Messages (Proper Fix)

**This requires core code changes** - not yet implemented in OpenClaw.

The fix moves per-turn volatile fields from system prompt to user-role context:

```typescript
// System prompt (cache-stable):
{
  role: "system",
  content: systemInstructions + sessionStableFields
  // Only: chat_id, channel, provider, chat_type (stable across turns)
}

// User message (per-turn volatile):
{
  role: "user",
  content: volatileMetadataPrefix + userMessage
  // message_id, reply_to_id, sender_id go here
}
```

**Related PR**: #20597 by @anisoptera implements this fix.

**Status**: Not yet merged (as of 2026.2.18).

### Option 2: Disable Inbound Metadata (Workaround)

**This loses metadata visibility** for the model.

If config option exists (check your version):

```json
{
  "agents": {
    "defaults": {
      "inboundMeta": {
        "enabled": false
      }
    }
  }
}
```

**Trade-off:** Model loses context about message IDs and replies, but caching works.

### Option 3: Use Non-Caching Models (Temporary)

Switch to models without caching while waiting for fix:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-5-20251101-v1:0"
        // Sonnet cheaper per token than broken Opus caching
      }
    }
  }
}
```

**Cost comparison:**

- Opus with broken cache: ~$84/day (measured example)
- Sonnet without cache: ~$12/day (for same workload)

## Cost Impact Analysis

### Normal Caching (Working)

**Token breakdown per turn (example):**

- System prompt: 45,000 tokens
- User message: 500 tokens
- Assistant response: 1,000 tokens

**Costs (Turn 2+):**

- cache_read (45,000 @ $0.30/MTok): $0.0135
- Input (500 @ $3/MTok): $0.0015
- Output (1,000 @ $15/MTok): $0.015
- **Total per turn**: $0.03

**Daily cost (50 turns/day)**: $1.50

### Broken Caching (Issue #20894)

**Token breakdown per turn:**

- cache_write (45,000 @ $3.75/MTok): $0.169
- cache_read (8,921 @ $0.30/MTok): $0.003
- Input (500 @ $3/MTok): $0.0015
- Output (1,000 @ $15/MTok): $0.015
- **Total per turn**: $0.189

**Daily cost (50 turns/day)**: $9.45

**Cost increase**: 6.3x (for this workload)

With longer conversations (more turns), the multiplier approaches **80-170x** as reported in #20894.

## Anthropic Caching Best Practices

### 1. System Prompt Should Be Session-Stable

**Good** (cache-friendly):

```json
{
  "role": "system",
  "content": "You are a helpful assistant. User: john@example.com. Channel: telegram. Chat ID: 123456789"
}
```

All values stay the same across turns in this session.

**Bad** (breaks cache):

```json
{
  "role": "system",
  "content": "You are a helpful assistant. Message ID: 98765. Timestamp: 2026-02-19T12:34:56Z"
}
```

Values change every turn.

### 2. Put Per-Turn Data in User Messages

**Volatile data belongs here:**

```json
{
  "role": "user",
  "content": "[Message ID: 98765, Reply to: 98764]\n\nUser's actual message here"
}
```

This doesn't affect system prompt caching.

### 3. Keep System Prompt Compact

Longer prompts = more cache_write cost when broken.

**Recommendations:**

- Remove unnecessary verbosity from SOUL.md
- Move examples to external knowledge base (fetch when needed)
- Use concise language in instructions

### 4. Monitor Cache Hit Rates

Track your cache efficiency:

```bash
# Example: parse logs to calculate cache hit rate
journalctl --user -u openclaw-gateway -n 1000 | \
  grep -oP 'cache_(read|write)=\K[0-9]+' | \
  awk '{
    if (NR % 2 == 1) read=$1;
    else write=$1;
    if (read > 0 && write == 0) hits++;
    total++;
  }
  END { print "Cache hit rate:", hits/total*100 "%" }'
```

**Good**: >80% cache hit rate
**Bad**: <20% cache hit rate (check for this issue)

### 5. Use Appropriate Models

Not all Anthropic models support caching:

**Caching supported:**

- Claude Opus 4.5 / 4.6
- Claude Sonnet 4.5 / 4.6

**No caching:**

- Claude Haiku
- Older model versions

If caching is broken anyway, Haiku may be more cost-effective.

## Monitoring Cost Trends

Set up alerts for cost anomalies:

```bash
# Daily cost check script
#!/bin/bash
YESTERDAY_COST=$(openclaw logs --since yesterday | \
  grep "anthropic" | \
  grep -oP 'cost=\K[0-9.]+' | \
  awk '{sum+=$1} END {print sum}')

if (( $(echo "$YESTERDAY_COST > 50" | bc -l) )); then
  echo "⚠️  High Anthropic API cost: \$$YESTERDAY_COST"
  echo "Check for prompt caching issues: #20894"
fi
```

## When to Use Caching

**Caching is most valuable when:**

- Long system prompts (>10,000 tokens)
- Many turns in same session (>5 turns)
- High request volume
- Using Opus (expensive base cost)

**Caching less valuable when:**

- Short system prompts (<5,000 tokens)
- One-shot requests
- Using Haiku (already cheap)
- Low request volume

If caching is broken (#20894) and you have short prompts + low volume, **Sonnet without cache** may be cheaper than Opus with broken cache.

## Related Issues

- **#20894**: Inbound metadata breaks caching (this issue)
- **#19965**: Timestamps in user messages (not system prompt - doesn't break caching)
- **PR #20597**: Proper fix by @anisoptera

## Temporary Cost Mitigation Strategies

While waiting for core fix:

1. **Switch to Sonnet** (cheaper per token)
2. **Reduce system prompt size** (less waste per turn)
3. **Use Opus only for complex tasks** (simple tasks → Sonnet/Haiku)
4. **Batch conversations** (fewer fresh sessions = less compaction)
5. **Disable inbound metadata** (if config exists)

## Expected Fix Timeline

**Core fix required**: Yes (code changes to `buildInboundMetaSystemPrompt()`)

**Complexity**: Low (move fields from system to user messages)

**PR available**: #20597 (not yet merged)

**Workaround**: Use Sonnet or disable metadata (if available)

## Verification After Fix

Once fix is deployed:

```bash
# Check cache behavior
openclaw logs --follow | grep -E "cache_write|cache_read"

# Should see:
# Turn 1: cache_write=45000, cache_read=0
# Turn 2: cache_write=0,     cache_read=45000  ← Good!
# Turn 3: cache_write=0,     cache_read=45000  ← Good!
```

## Related Documentation

- [Anthropic Provider](/providers/anthropic)
- [Model Configuration](/concepts/models)
- [Cost Optimization](/concepts/cost-optimization)

## External Resources

- Anthropic Prompt Caching Docs: <https://docs.anthropic.com/claude/docs/prompt-caching>
- Issue #20894: <https://github.com/openclaw/openclaw/issues/20894>
- Fix PR #20597: <https://github.com/openclaw/openclaw/pull/20597>

---

**Last updated**: February 19, 2026
**Status**: Issue confirmed, fix available in PR #20597 (not yet merged)
