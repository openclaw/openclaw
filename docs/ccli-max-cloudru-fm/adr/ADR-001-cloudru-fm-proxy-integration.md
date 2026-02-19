# ADR-001: Cloud.ru FM Proxy Integration Architecture

## Status: ACCEPTED

## Date: 2026-02-13 (v2 — rewritten after DDD analysis + brutal honesty review + research)

## Context

OpenClaw needs Cloud.ru Evolution Foundation Models (GLM-4.7, Qwen3-Coder-480B). Cloud.ru FM uses OpenAI-compatible API at `https://foundation-models.api.cloud.ru/v1/`; Claude Code expects Anthropic-format. A protocol translation layer is needed.

OpenClaw already has `claude-cli` backend spawning Claude Code as subprocess (`src/agents/cli-runner.ts`). The `claude-code-proxy` Docker container translates Anthropic -> OpenAI format.

### Platform Context (from Research)

Cloud.ru Evolution AI Factory provides 6 integrated services:

- **Foundation Models**: 20+ LLMs (GLM-4.7, Qwen3, DeepSeek, GigaChat) via OpenAI-compatible API
- **AI Agents**: Visual editor, MCP integration, A2A protocol (up to 5 agents)
- **Managed RAG**: Knowledge bases, vector search, document parsing
- **ML Inference**: Custom model deployment with auto-scaling
- **ML Finetuning**: LoRA/QLoRA on proprietary data
- **Notebooks**: Jupyter-like GPU environments

### Why Proxy (Not Direct API)

Despite OpenAI-compatible endpoints, 3 incompatibilities require a proxy layer:

1. **Auth format**: Claude Code sends `x-api-key` + `anthropic-version`; Cloud.ru expects `Authorization: Bearer`
2. **Model mapping**: Claude Code requests `claude-opus-4-6`; Cloud.ru uses `zai-org/GLM-4.7`
3. **Tool call format**: GLM sometimes simulates tool calls in text instead of structured `tool_calls` (Insight #055)

### Target Users

- **Russian market**: No VPN, Russian payment cards, FZ-152 compliant data storage
- **Free tier**: GLM-4.7-Flash available at zero cost for development
- **MAX Messenger**: Pre-installed on all Russian smartphones since Sep 2025 — primary user channel

## Decision

### Architecture Flow

```
User -> MAX/Telegram/Web -> OpenClaw Gateway -> runCliAgent()
  -> claude -p -> Claude Code
    -> ANTHROPIC_BASE_URL=localhost:8082 -> claude-code-proxy (Docker)
      -> cloud.ru FM API (15 req/s rate limit) -> GLM-4.7 / Qwen3 / Flash
```

### Bounded Contexts (DDD)

| Context            | Responsibility                      | Files                                                  |
| ------------------ | ----------------------------------- | ------------------------------------------------------ |
| **Onboarding**     | Credential capture, config mutation | auth-choice.apply.cloudru-fm.ts, onboard-cloudru-fm.ts |
| **Configuration**  | Type-safe schema, Zod validation    | cloudru-fm.constants.ts, onboard-types.ts              |
| **Execution**      | CLI backend merge, model routing    | cli-backends.ts, cli-runner.ts                         |
| **Infrastructure** | Docker proxy lifecycle              | cloudru-proxy-template.ts, cloudru-proxy-health.ts     |

### Key Design Decisions

1. **Sentinel API key** (`not-a-real-key-proxy-only`): Claude Code requires non-empty ANTHROPIC_API_KEY; proxy ignores it
2. **clearEnv scoped to override**: Extended clearEnv applied only to cloudru-fm backend, not global DEFAULT_CLAUDE_BACKEND
3. **Localhost-only binding**: Docker ports `127.0.0.1:8082` AND `[::1]:8082` — CRITICAL for security (prevents API key exposure)
4. **API key in .env only**: Never in openclaw.json; referenced as `${CLOUDRU_API_KEY}` in Docker Compose
5. **.env append (not overwrite)**: Preserves existing .env content
6. **Rate limit awareness**: Cloud.ru FM has 15 req/s per key; `serialize: true` in backend config prevents bursting

### Known GLM Behavioral Issues (from Research)

| #   | Issue                                      | Severity | Mitigation                         |
| --- | ------------------------------------------ | -------- | ---------------------------------- |
| 1   | Ignores XML skill sections                 | High     | Use dispatch tables, not XML       |
| 2   | Simulates tool calls in text               | High     | Proxy validates tool_calls format  |
| 3   | Streaming parse crash (tag duplication)    | Medium   | sglang #15721 — proxy handles      |
| 4   | Context loss with prompts >4000 chars      | Medium   | Keep system prompts compact        |
| 5   | RLHF refusals (GLM-4.6, potentially Flash) | Medium   | Anti-refusal instructions          |
| 6   | Thinking mode conflicts with streaming     | Medium   | Disable thinking for agentic tasks |
| 7   | Code reformatting by model                 | Low      | EditorConfig + linters             |

## Consequences

- Zero Claude Code modifications required
- +50-100ms proxy latency per request
- Docker required (manual setup documented as fallback)
- `serialize: true` limits to 1 concurrent request per agent
- Enables future integration with Cloud.ru AI Agents (A2A protocol) and Managed RAG

## References

- [Cloud.ru FM API](https://foundation-models.api.cloud.ru/v1/)
- [Cloud.ru Wiki: Claude Code + Evo FM](https://wiki.cloud.ru/spaces/IA/pages/630602538)
- [claude-code-proxy](https://github.com/fuergaosi233/claude-code-proxy)
- `docs/ccli-max-cloudru-fm/RESEARCH.md` — Full Claude Code vs OpenCode comparison
- `docs/ccli-max-cloudru-fm/research/` — Architecture, AI Agents, MAX integration research
