# ADR-005: Model Mapping and Fallback Strategy

## Status: ACCEPTED

## Date: 2026-02-13 (v2 — updated with full model catalog from research)

## Bounded Context: Model Routing

## Context

Claude Code internally uses 3 model tiers (Opus, Sonnet, Haiku). The
claude-code-proxy maps these to Cloud.ru FM models via environment variables.
GLM-4.7 has known tool calling instabilities that may cause failures at runtime.
A robust fallback strategy is needed.

### Available Models on Cloud.ru (from Research)

| Model                | Developer | Parameters | Context | Tool Calling        | Free    |
| -------------------- | --------- | ---------- | ------- | ------------------- | ------- |
| **GLM-4.7**          | Zhipu AI  | 358B MoE   | 200K    | Yes (thinking mode) | No      |
| **GLM-4.7-FlashX**   | Zhipu AI  | MoE        | 200K    | Yes                 | No      |
| **GLM-4.7-Flash**    | Zhipu AI  | MoE        | 200K    | Yes                 | **Yes** |
| **Qwen3-Coder-480B** | Alibaba   | 480B MoE   | 128K    | Yes                 | No      |
| **Qwen3-Coder-Next** | Alibaba   | MoE        | 128K    | Yes                 | No      |
| Qwen3-235B           | Alibaba   | 235B MoE   | 128K    | Yes                 | No      |
| DeepSeek-V3          | DeepSeek  | 671B MoE   | 128K    | Yes                 | No      |
| DeepSeek-R1          | DeepSeek  | 671B MoE   | 128K    | Yes (reasoning)     | No      |
| GigaChat-2-Max       | Sber      | —          | 32K     | Limited             | No      |
| T-pro-it-2.0         | T-Bank    | —          | 32K     | Limited             | No      |
| MiniMax-M2           | MiniMax   | —          | —       | Yes                 | No      |

### DDD Value Object: ModelMapping

```typescript
// Defined in src/config/cloudru-fm.constants.ts
type CloudruModelPreset = {
  big: string; // Opus tier
  middle: string; // Sonnet tier
  small: string; // Haiku tier
  label: string;
  free: boolean;
};
```

## Decision

### Primary Presets (Wizard Choices)

| Choice                   | BIG_MODEL (Opus)                    | MIDDLE_MODEL (Sonnet)  | SMALL_MODEL (Haiku)   | Free    |
| ------------------------ | ----------------------------------- | ---------------------- | --------------------- | ------- |
| **GLM-4.7 (Full)**       | zai-org/GLM-4.7                     | zai-org/GLM-4.7-FlashX | zai-org/GLM-4.7-Flash | No      |
| **GLM-4.7-Flash (Free)** | zai-org/GLM-4.7-Flash               | zai-org/GLM-4.7-Flash  | zai-org/GLM-4.7-Flash | **Yes** |
| **Qwen3-Coder-480B**     | Qwen/Qwen3-Coder-480B-A35B-Instruct | zai-org/GLM-4.7-FlashX | zai-org/GLM-4.7-Flash | No      |

### Mapping Rationale

- **GLM-4.7** as Opus: Top model, 358B params, 200K context, SWE-bench 73.8%
- **GLM-4.7-FlashX** as Sonnet: Balanced speed/quality, same 200K context
- **GLM-4.7-Flash** as Haiku: Free tier, fast inference, always available as fallback
- **Qwen3-Coder-480B** as Opus (code preset): Code-specialized, 480B params

### Fallback Chain

When a model fails (timeout, 5xx, tool call error):

```
GLM-4.7 -> GLM-4.7-FlashX -> GLM-4.7-Flash -> ERROR
Qwen3-Coder -> GLM-4.7-FlashX -> GLM-4.7-Flash -> ERROR
GLM-4.7-Flash -> ERROR (no fallback for free tier)
```

Fallback is handled by OpenClaw's existing `runAgentTurnWithFallback()` in
`agent-runner.ts`, which supports model fallback lists via
`agents.defaults.model.fallbacks` in config.

**NOTE**: Proxy-level failure (proxy down) bypasses fallback entirely — all tiers
hit the same dead proxy. `ensureProxyHealthy()` throws plain Error for this case.

### GLM-4.7 Tool Calling Mitigations (from Research)

| Issue                            | Severity | Mitigation                          | Where             |
| -------------------------------- | -------- | ----------------------------------- | ----------------- |
| Streaming tool call parse crash  | Medium   | Proxy handles tag deduplication     | claude-code-proxy |
| Tool call simulation in text     | High     | Proxy validates `tool_calls` format | claude-code-proxy |
| RLHF refusals                    | Medium   | Anti-refusal in system prompt       | OpenClaw config   |
| System prompt attention loss >4K | Medium   | Keep prompts compact                | OpenClaw config   |
| Thinking mode conflicts          | Medium   | Disable: `DISABLE_THINKING=true`    | proxy .env        |
| MAX_TOKENS default too low       | Low      | Override: `MAX_TOKENS_LIMIT=16384`  | proxy .env        |

### Prompt Engineering Recommendations (from Research)

```markdown
# System prompt rules for GLM-4.7-Flash:

1. CRITICAL instructions in FIRST line (attention-weighted)
2. Use DISPATCH TABLES, not XML sections
3. Keep total prompt < 4000 characters
4. Explicit anti-simulation: "NEVER simulate tool results"
5. Disable thinking mode for agentic tasks
```

### Rate Limiting

Cloud.ru FM imposes **15 req/s per API key**. Mitigations:

- `serialize: true` in backend config (1 request at a time)
- OpenClaw's existing request queue
- Future: multiple API keys for horizontal scaling

## Consequences

### Positive

- Default preset uses free tier (GLM-4.7-Flash) — zero cost to start
- 3 curated presets simplify model selection
- Fallback chain provides resilience
- Existing OpenClaw fallback infrastructure handles retries
- Known GLM issues documented with specific mitigations

### Negative

- Model mapping in proxy env — requires container restart to change
- Fallback changes model mid-conversation (quality variance)
- GLM-4.7-Flash has lower quality than paid models
- No dynamic routing based on task complexity (all tiers predetermined)
- 15 req/s rate limit constrains multi-user throughput

### Invariants

1. **SMALL_MODEL must always be GLM-4.7-Flash** (free tier guarantee for fallback)
2. **Proxy must have all 3 MODEL envs set** (BIG_MODEL, MIDDLE_MODEL, SMALL_MODEL)
3. **Model fallback list must terminate** (no circular fallbacks)
4. **Presets must match constants** (`CLOUDRU_FM_PRESETS` in cloudru-fm.constants.ts is SoT)

## References

- `src/config/cloudru-fm.constants.ts` — CLOUDRU_FM_MODELS, CLOUDRU_FM_PRESETS
- `src/agents/cli-backends.ts:10-28` — CLAUDE_MODEL_ALIASES
- `docs/ccli-max-cloudru-fm/RESEARCH.md` — Section 6 (model recommendations)
- `docs/ccli-max-cloudru-fm/research/cloudru-ai-agents-integration.md` — Full model catalog
- [Cloud.ru FM Products](https://cloud.ru/products/evolution-foundation-models)
