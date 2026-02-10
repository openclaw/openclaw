---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Session Pruning"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Session pruning: tool-result trimming to reduce context bloat"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to reduce LLM context growth from tool outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are tuning agents.defaults.contextPruning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Session Pruning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session pruning trims **old tool results** from the in-memory context right before each LLM call. It does **not** rewrite the on-disk session history (`*.jsonl`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## When it runs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `mode: "cache-ttl"` is enabled and the last Anthropic call for the session is older than `ttl`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only affects the messages sent to the model for that request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only active for Anthropic API calls (and OpenRouter Anthropic models).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For best results, match `ttl` to your model `cacheControlTtl`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- After a prune, the TTL window resets so subsequent requests keep cache until `ttl` expires again.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Smart defaults (Anthropic)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OAuth or setup-token** profiles: enable `cache-ttl` pruning and set heartbeat to `1h`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **API key** profiles: enable `cache-ttl` pruning, set heartbeat to `30m`, and default `cacheControlTtl` to `1h` on Anthropic models.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you set any of these values explicitly, OpenClaw does **not** override them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What this improves (cost + cache behavior)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Why prune:** Anthropic prompt caching only applies within the TTL. If a session goes idle past the TTL, the next request re-caches the full prompt unless you trim it first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **What gets cheaper:** pruning reduces the **cacheWrite** size for that first request after the TTL expires.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Why the TTL reset matters:** once pruning runs, the cache window resets, so follow‑up requests can reuse the freshly cached prompt instead of re-caching the full history again.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **What it does not do:** pruning doesn’t add tokens or “double” costs; it only changes what gets cached on that first post‑TTL request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What can be pruned（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only `toolResult` messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- User + assistant messages are **never** modified.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The last `keepLastAssistants` assistant messages are protected; tool results after that cutoff are not pruned.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If there aren’t enough assistant messages to establish the cutoff, pruning is skipped.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool results containing **image blocks** are skipped (never trimmed/cleared).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context window estimation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pruning uses an estimated context window (chars ≈ tokens × 4). The base window is resolved in this order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `models.providers.*.models[].contextWindow` override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Model definition `contextWindow` (from the model registry).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Default `200000` tokens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `agents.defaults.contextTokens` is set, it is treated as a cap (min) on the resolved window.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### cache-ttl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pruning only runs if the last Anthropic call is older than `ttl` (default `5m`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When it runs: same soft-trim + hard-clear behavior as before.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Soft vs hard pruning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Soft-trim**: only for oversized tool results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Keeps head + tail, inserts `...`, and appends a note with the original size.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Skips results with image blocks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Hard-clear**: replaces the entire tool result with `hardClear.placeholder`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool selection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.allow` / `tools.deny` support `*` wildcards.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deny wins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Matching is case-insensitive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Empty allow list => all tools allowed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Interaction with other limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Built-in tools already truncate their own output; session pruning is an extra layer that prevents long-running chats from accumulating too much tool output in the model context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Compaction is separate: compaction summarizes and persists, pruning is transient per request. See [/concepts/compaction](/concepts/compaction).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Defaults (when enabled)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ttl`: `"5m"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `keepLastAssistants`: `3`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `softTrimRatio`: `0.3`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hardClearRatio`: `0.5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `minPrunableToolChars`: `50000`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default (off):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    contextPruning: { mode: "off" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable TTL-aware pruning:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    contextPruning: { mode: "cache-ttl", ttl: "5m" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restrict pruning to specific tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    contextPruning: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mode: "cache-ttl",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tools: { allow: ["exec", "read"], deny: ["*image*"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See config reference: [Gateway Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
