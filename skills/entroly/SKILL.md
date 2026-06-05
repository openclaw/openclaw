---
name: entroly
description: "Compress repo context before sending to LLM providers. Reduces input tokens by 70-95% on large repos using knapsack optimization, entropy scoring, and cache alignment."
metadata:
  {
    "openclaw":
      {
        "emoji": "🗜️",
        "requires":
          {
            "anyBins": ["entroly"],
            "config": ["skills.entries.entroly.enabled"],
          },
        "install":
          [
            {
              "id": "pip-entroly",
              "kind": "pip",
              "package": "entroly",
              "bins": ["entroly"],
              "label": "Install Entroly (pip)",
            },
          ],
      },
  }
---

# Entroly — Context Compression

Use when LLM requests are large, repetitive, or hitting token limits. Not needed for short prompts or single-file lookups.

## What it does

Entroly is a local context compression engine that sits between OpenClaw's coding workers and the LLM provider:

1. **Ranks** every repo file by relevance to the current query (BM25 + entropy + dependency graph)
2. **Selects** the optimal subset under a token budget (knapsack optimization)
3. **Compresses** noisy context while keeping originals recoverable (CCR handles)
4. **Aligns** cache prefixes so provider discounts activate (Anthropic 90%, OpenAI 50%)
5. **Verifies** the reply with WITNESS hallucination guard ($0, ~3ms)

## When to use

- Large repos (500+ files) where agents re-read the same context
- Multi-file refactors, issue-to-PR loops, or PR reviews on big codebases
- When LLM costs are a concern and token budgets are tight

## When NOT to use

- Short prompts under 4K tokens
- Single-file edits where the agent already knows which file to send
- Workflows requiring unmodified raw text

## Setup

### Proxy mode (recommended — zero config change to workers)

```bash
entroly proxy
# Workers automatically route through localhost:9377
# Set OPENAI_BASE_URL=http://localhost:9377/v1 or equivalent
```

### Wrap mode (per-worker)

```bash
entroly wrap codex
entroly wrap claude
entroly wrap opencode
```

### MCP server mode

```bash
entroly serve
# Add as MCP server in OpenClaw config
```

## Usage with coding-agent skill

When launching background coding workers, prepend the entroly proxy:

```bash
# Start the proxy in background
bash background:true command:"entroly proxy --port 9377"

# Workers automatically get compressed context
# No changes needed to worker prompts
```

Or wrap individual workers:

```bash
bash pty:true background:true workdir:/path/repo command:"entroly wrap codex exec - < \"$PROMPT\""
```

## Verify installation

```bash
entroly verify-claims
```

Runs a bounded local smoke test: package import, indexing, context optimization, exact recovery, native-engine availability. Writes `.entroly_verification.json`. No API key required.

## Expected results

- 70–95% fewer input tokens on repos with 500+ files
- 100% accuracy retained (NeedleInAHaystack, BFCL benchmarks)
- WITNESS hallucination detection: 0.844 AUROC on HaluEval-QA
- Cache hit improvement: up to 90% provider discount captured

Small prompts and tiny repos may show little or no savings.

## Links

- GitHub: https://github.com/juyterman1000/entroly
- License: Apache-2.0
- Local-first, no outbound analytics by default
