# ADR-003: Claude Code as Agentic Execution Engine

## Status: ACCEPTED

## Date: 2026-02-13 (v2 — updated with research findings)

## Bounded Context: Agent Execution

## Context

OpenClaw routes user messages through an agent execution pipeline. When the provider
is `claude-cli`, OpenClaw spawns Claude Code as a subprocess via `runCliAgent()` in
`cli-runner.ts`. Claude Code then processes the user's message with its full agentic
architecture — multi-step reasoning, tool calling, MCP servers, session persistence.

### Strategic Insight (from Research)

Claude Code + proxy scored **8.0/10** vs OpenCode at **7.6/10** in the hybrid comparison:

- Claude Code wins: MCP (10/10), agent capabilities (10/10), hooks (9/10), persistent context (10/10)
- OpenCode wins: model flexibility (10/10), startup simplicity (9/10), open source
- **Verdict**: Claude Code + proxy for agentic coding; OpenCode for model experimentation

### Why Claude Code, Not Direct API

Claude Code adds architectural value beyond the model:

1. **Decomposes** complex tasks into sub-steps internally
2. **Orchestrates** tools (file read/write, bash, search) autonomously
3. **Maintains** session state across conversation turns
4. **Applies** CLAUDE.md project instructions persistently
5. **Validates** its own output through multi-step verification

The underlying model (GLM-4.7) benefits from this "chassis" — producing results
that exceed what the model alone would generate via direct API call.

### Cloud.ru AI Agents: Complementary, Not Competing

From research on Cloud.ru Evolution AI Agents:

- Cloud.ru supports up to 5 native agents per system with proprietary A2A protocol
- External agent participation is via REST API (not native A2A)
- OpenClaw uses Claude Code as its agent engine, calling Cloud.ru FM for model inference only
- Future: Could integrate Cloud.ru Managed RAG as MCP server for knowledge bases

### DDD Aggregate: AgentExecution

The agent execution aggregate encapsulates the complete lifecycle of a user
message being processed by an agent backend. For the `claude-cli` provider,
this aggregate includes subprocess spawning, I/O management, session persistence,
and result parsing.

## Decision

Use OpenClaw's **existing** `claude-cli` backend (`cli-backends.ts`, `cli-runner.ts`)
as the primary execution path for Cloud.ru FM conversations.

### Execution Flow

```
1. User sends message (MAX/Telegram/Web)
2. OpenClaw gateway receives message
3. agent-runner.ts:378 — isCliProvider() returns true for "claude-cli"
4. runCliAgent() spawns subprocess:
   claude -p --output-format json --dangerously-skip-permissions \
     --model opus \
     --session-id <session-id> \
     --append-system-prompt "<openclaw-system-prompt>" \
     "<user-message>"
5. Environment injected:
   ANTHROPIC_BASE_URL=http://localhost:8082  (proxy)
   ANTHROPIC_API_KEY=not-a-real-key-proxy-only
6. Claude Code -> proxy -> cloud.ru FM (15 req/s limit) -> response
7. Response parsed as JSON -> delivered to user
```

### Pre-Flight Health Check (CRIT-02 Fix)

Before spawning Claude Code subprocess, verify proxy health:

```typescript
// In runCliAgent() or agent-runner.ts routing layer
import { ensureProxyHealthy } from "./cloudru-proxy-health.js";

if (backendConfig.name === "cloudru-fm") {
  await ensureProxyHealthy(backendConfig.env.ANTHROPIC_BASE_URL);
}
```

`ensureProxyHealthy()` throws plain Error (NOT FailoverError) because all tiers
share the same proxy — model-level fallback is pointless when proxy is dead.

### Session Continuity

The `claude-cli` backend uses `sessionMode: "always"` and passes `--session-id`
on every call. When a session exists, `resumeArgs` are used with `--resume`.

### Tools Disabled (Intentional)

`cli-runner.ts:82-83` injects: "Tools are disabled in this session."
This prevents Claude Code from using file operations in OpenClaw sessions because:

- OpenClaw manages its own tool layer (skills, MCP, web search)
- Enabling Claude Code tools would require workspace isolation per user
- Security implications of arbitrary tool execution per user message

### Prompt Engineering for GLM (from Research)

System prompts for Cloud.ru FM backend should:

- Stay under 4000 characters (GLM attention drops beyond this)
- Use dispatch tables instead of XML sections (GLM ignores XML)
- Include anti-refusal instructions (RLHF residue from GLM-4.6)
- Disable thinking mode for agentic stability

## Consequences

### Positive

- Zero code changes to OpenClaw core — config-only integration
- Full Claude Code reasoning pipeline enhances model output quality
- Session persistence provides conversation continuity
- Pre-flight health check prevents silent proxy failures

### Negative

- Subprocess overhead: ~2-5s startup per cold call
- `serialize: true` limits to 1 concurrent request globally
- Tools disabled limits Claude Code to pure reasoning
- Rate limit (15 req/s) constrains throughput

### Invariants (DDD)

1. **Session Identity**: Every OpenClaw conversation maps to exactly one Claude Code session ID
2. **Backend Resolution**: `resolveCliBackendConfig("claude-cli", cfg)` must always return valid config
3. **Environment Isolation**: `clearEnv` removes leaked keys before applying user-configured env
4. **Proxy Health**: Health check MUST run before first request in session

## References

- `src/agents/cli-backends.ts:30-53` — DEFAULT_CLAUDE_BACKEND config
- `src/agents/cli-runner.ts:35-324` — runCliAgent() full implementation
- `src/agents/cloudru-proxy-health.ts` — ensureProxyHealthy()
- `docs/ccli-max-cloudru-fm/RESEARCH.md` — Section 4 (comparison matrix)
- `docs/ccli-max-cloudru-fm/research/cloudru-ai-agents-integration.md` — A2A protocol analysis
