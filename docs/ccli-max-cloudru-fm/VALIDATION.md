# Architecture Decision Validation: OpenClaw + Claude Code + Cloud.ru FM

## Decision Under Review

Use Claude Code as the agentic engine for OpenClaw user responses,
powered by cloud.ru Evolution Foundation Models via claude-code-proxy.

## Validation Result: APPROVED

### Key Discovery

OpenClaw **already has a built-in CLI backend architecture** that natively supports
Claude Code as the agent execution engine (`src/agents/cli-backends.ts`,
`src/agents/cli-runner.ts`).

The `claude-cli` provider spawns Claude Code as a subprocess:
```
claude -p --output-format json --dangerously-skip-permissions
```

This means Claude Code's full multi-agent architecture (tool calling, MCP,
multi-step reasoning, file operations) is available to OpenClaw users.

## How It Works

```
User (Telegram/Web)
  → OpenClaw Gateway
    → runCliAgent() [src/agents/cli-runner.ts]
      → spawns: claude -p --output-format json
        → Claude Code (with ANTHROPIC_BASE_URL=localhost:8082)
          → claude-code-proxy (Docker)
            → cloud.ru Foundation Models API
              → GLM-4.7-Flash / Qwen3 / etc.
```

## Configuration Required

### 1. claude-code-proxy (Docker)

```yaml
# docker-compose.yml
services:
  claude-code-proxy:
    image: legard/claude-code-proxy:v1.0.0  # Pinned version per ADR-004
    ports:
      - "127.0.0.1:8082:8082"
    environment:
      OPENAI_API_KEY: "${CLOUDRU_API_KEY}"
      OPENAI_BASE_URL: "https://foundation-models.api.cloud.ru/v1"
      BIG_MODEL: "zai-org/GLM-4.7"
      MIDDLE_MODEL: "Qwen/Qwen3-Coder-480B-A35B-Instruct"
      SMALL_MODEL: "zai-org/GLM-4.7-Flash"
```

### 2. OpenClaw config (openclaw.json)

```json
{
  "agents": {
    "defaults": {
      "cliBackends": {
        "claude-cli": {
          "command": "claude",
          "env": {
            "ANTHROPIC_BASE_URL": "http://localhost:8082",
            "ANTHROPIC_API_KEY": "any-key"
          }
        }
      }
    }
  }
}
```

### 3. Set agent provider to `claude-cli`

In the wizard or config, set the agent's provider to `claude-cli` with
model `opus` (mapped to GLM-4.7 by the proxy).

## Architecture Validation

### Why This Works (User's Insight Confirmed)

> "Claude Code's architecture makes task quality HIGHER than model quality alone"

This is architecturally correct because:

1. **Multi-step reasoning**: Claude Code decomposes complex tasks internally
2. **Tool orchestration**: File read/write, bash, search — all handled by Claude Code
3. **Session persistence**: OpenClaw passes `--session-id` for conversation continuity
4. **System prompt injection**: OpenClaw adds context via `--append-system-prompt`
5. **Structured output**: JSON results parsed by OpenClaw for clean delivery

The model (GLM-4.7) benefits from Claude Code's agent framework the same way
a good engine benefits from a well-engineered chassis.

### Existing Code Evidence

| File | What It Does |
|------|-------------|
| `src/agents/cli-backends.ts` | Defines `claude-cli` backend config with args, env, model aliases |
| `src/agents/cli-runner.ts` | Spawns Claude Code subprocess, handles I/O, sessions |
| `src/agents/cli-runner/helpers.js` | Builds CLI args, parses JSON output, manages sessions |
| `src/auto-reply/reply/agent-runner.ts:378` | Routes to CLI backend when provider is `claude-cli` |
| `src/auto-reply/reply/agent-runner.claude-cli.test.ts` | Tests confirming claude-cli routing works |

### Known Limitations

| Limitation | Current Code | Impact | Fix |
|------------|-------------|--------|-----|
| Tools disabled | cli-runner.ts:83 `"Tools are disabled"` | No file/bash tools | Remove in fork |
| Serialized execution | cli-backends.ts:52 `serialize: true` | 1 request at a time | Multiple backend instances |
| Subprocess latency | ~2-5s startup per call | Slower responses | Session resume, warm pool |
| GLM tool calling | sglang #15721 | May crash on streaming | Proxy validation |
| No block streaming | CLI returns full result | No typing indicator during processing | Accept trade-off |

## Corrected Implementation Plan

### Wizard Changes (~150 lines)

1. Add `"cloudru-fm"` auth choice to wizard
2. Pre-fill cloud.ru Base URL + model picker
3. Auto-configure `claude-cli` backend with proxy env
4. Optionally deploy claude-code-proxy via Docker
5. Health check: verify proxy → cloud.ru connectivity

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  OpenClaw Installation Wizard                                │
│                                                              │
│  Step 1: Model Provider                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌────────────┐ │
│  │ Anthropic │ │ OpenAI   │ │ Cloud.ru FM  │ │ Custom     │ │
│  │ (direct)  │ │ (direct) │ │ (via proxy)  │ │ (manual)   │ │
│  └──────────┘ └──────────┘ └──────┬───────┘ └────────────┘ │
│                                   │                          │
│  Step 2: Cloud.ru Configuration   │                          │
│  ├─ API Key: [____________]       │                          │
│  ├─ Model:   [GLM-4.7-Flash ▾]   │                          │
│  └─ Deploy proxy? [Yes/No]        │                          │
│                                   │                          │
│  Step 3: Agent Mode               │                          │
│  ├─ [x] Use Claude Code engine    │ ← KEY: enables CLI backend│
│  │      (multi-agent, tools, MCP) │                          │
│  └─ [ ] Direct API calls          │                          │
│         (simpler, faster)         │                          │
│                                   │                          │
│  Auto-configures:                 │                          │
│  • docker-compose for proxy       │                          │
│  • cliBackends.claude-cli.env     │                          │
│  • Provider: claude-cli           │                          │
└─────────────────────────────────────────────────────────────┘
```

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|:-----------:|:------:|-----------|
| GLM can't follow Claude Code's internal prompts | Medium | High | Test with GLM-4.7 (not Flash), fallback to Qwen3-Coder |
| Subprocess overhead too high | Low | Medium | Session resume reduces to ~1s |
| Proxy crashes under load | Low | High | Docker restart, health checks |
| Tools disabled limitation | Known | Medium | Fork OpenClaw to enable tools |
| Serialize bottleneck (1 req/time) | High | Medium | Multiple backend instances |

## Sources

- `src/agents/cli-backends.ts` — CLI backend configuration
- `src/agents/cli-runner.ts` — CLI agent execution
- `src/auto-reply/reply/agent-runner.claude-cli.test.ts` — Integration test
- [claude-code-proxy](https://github.com/fuergaosi233/claude-code-proxy)
- [Cloud.ru Wiki: Claude Code + Evo FM](https://wiki.cloud.ru/spaces/IA/pages/630602538)
