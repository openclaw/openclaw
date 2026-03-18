# OpenClaw System Inventory

This document is the fast operational companion to the audit. It is meant to answer one question quickly:

Where should a contributor start, and what are they really touching when they change a subsystem?

## Repository shape

Approximate TypeScript hotspot areas from the current repo snapshot:

- `src/agents`: about 199k LOC
- `src/gateway`: about 90k LOC
- `src/infra`: about 88k LOC
- `src/auto-reply`: about 70k LOC
- `src/plugins`: about 41k LOC
- `src/memory`: about 21k LOC

Breadth indicators:

- around 687 markdown docs under `docs/`
- around 1951 colocated `*.test.ts` files under `src/`
- many plugin packages under `extensions/*`
- apps under `apps/android`, `apps/ios`, `apps/macos`, and `apps/shared`

## Main ownership boundaries

### Gateway control plane

Representative files:

- `src/gateway/server.impl.ts`
- `src/gateway/server-methods.ts`
- `src/gateway/server/ws-connection.ts`
- `src/gateway/server-ws-runtime.ts`

Owns:

- HTTP and WebSocket surfaces
- auth, pairing, scopes, and operator control
- request dispatch
- channel lifecycle and startup sidecars
- background system services

### Native agent runtime

Representative files:

- `src/agents/agent-command.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-subscribe.ts`

Owns:

- session preparation
- model and auth resolution
- queueing and serialization
- runtime execution
- streamed tool and assistant events
- final payload shaping

### Routing and sessions

Representative files:

- `src/config/sessions.ts`
- `src/sessions/*`
- `src/routing/*`
- `src/channels/*`

Owns:

- session key semantics
- direct versus group routing
- account and peer binding
- transport-aware delivery identity
- session persistence and maintenance

### Memory and context

Representative files:

- `src/context-engine/*`
- `src/memory/manager.ts`
- `src/memory/qmd-manager.ts`

Owns:

- context assembly
- compaction behavior
- retrieval behavior
- embedding-backed and QMD-backed memory search
- session-export and memory-file indexing

### Extensibility platform

Representative files:

- `src/plugins/loader.ts`
- `src/plugins/runtime/index.ts`
- `src/plugins/tools.ts`
- `src/plugins/registry.ts`
- `extensions/*`

Owns:

- plugin discovery and validation
- runtime registration
- capability ownership
- provider/channel/tool/service/hook extension points

### Delegation and external runtimes

Representative files:

- `src/agents/subagent-registry.ts`
- `src/cron/*`
- `src/acp/*`

Owns:

- background delegated runs
- persistent and ephemeral subagent sessions
- scheduled work
- external coding harness sessions through ACP

## Execution surfaces

### User-facing ingress

- messaging channels
- CLI
- WebChat and Control UI
- mobile and desktop nodes

### Control-plane ingress

- typed Gateway WebSocket protocol
- node capabilities
- operator methods for config, sessions, models, skills, cron, and browser

### Agent-facing execution

- core tools
- plugin tools
- skills prompt injection
- memory tools
- session tools

## Best starting points by contribution type

### If you like backend orchestration

Start in:

- `src/agents/agent-command.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/subagent-registry.ts`

Good work types:

- lifecycle cleanup
- retries and timeouts
- run explainability
- orchestration contract cleanup

### If you like systems and control planes

Start in:

- `src/gateway/server.impl.ts`
- `src/gateway/server-methods.ts`
- `src/gateway/server/ws-connection.ts`

Good work types:

- request visibility
- auth and policy clarity
- operator diagnostics
- protocol ergonomics

### If you like search, retrieval, and memory

Start in:

- `src/memory/manager.ts`
- `src/memory/qmd-manager.ts`
- `src/context-engine/*`

Good work types:

- backend diagnostics
- retrieval quality instrumentation
- scope transparency
- compaction behavior visibility

### If you like platforms and extensibility

Start in:

- `src/plugins/loader.ts`
- `src/plugins/runtime/index.ts`
- `src/plugins/tools.ts`
- `docs/tools/plugin.md`

Good work types:

- contributor ergonomics
- plugin debugging
- capability ownership clarity
- registry visibility

### If you like product and DX docs

Start in:

- `docs/concepts/*`
- `docs/tools/*`
- `docs/gateway/*`
- `CONTRIBUTING.md`

Good work types:

- subsystem maps
- execution model docs
- proposal-ready diagrams
- maintainer-facing contributor guides

## Current architectural pressure points

### Pressure point 1: orchestration paths

Similar semantics appear across:

- native agent runs
- subagents
- ACP sessions
- cron isolated jobs

That makes this area high leverage and high risk.

### Pressure point 2: memory observability

Memory behavior is strong but difficult to inspect, especially across provider fallback, QMD behavior, and scope-based denials.

### Pressure point 3: plugin reasoning

The plugin platform is sophisticated, but a contributor often has to understand discovery, validation, activation, runtime loading, and registry consumption just to change one feature.

## Recommended contribution zones

### Low-risk, high-signal

- memory diagnostics
- plugin introspection docs and status surfaces
- run trace visibility

### Medium-risk, high-upside

- execution-target normalization
- subagent and ACP behavior alignment
- contributor-facing architecture navigation

### Higher-risk architectural work

- queue-lane model changes
- protocol-wide lifecycle changes
- deep plugin loader contract changes
- session-key semantics
