# MCP Server Architecture

## Primary integration boundary

`radar-claw-defender` is designed as an MCP server first because the main integration target is tool-based defensive review, not a broad HTTP service. MCP lets the project expose a narrow, explicit, and auditable tool surface.

## Why this fits Radar Meseriași

Radar Meseriași needs repeatable review around:

- auth and ownership boundaries
- RLS assumptions
- OTP abuse paths
- webhook trust
- data exposure and validation

Those are best expressed as small review tools with typed inputs and structured outputs.

## Server shape

- runtime defaults and config loading in `src/context/*`
- shared review logic in `src/core/*`
- deterministic recommendation mapping in `src/policies/*`
- MCP transport and tool registration in `src/mcp/*`

## Fork maintenance boundary

The MCP server should live inside an evergreen fork model:

- `main` stays close to upstream OpenClaw
- `radar/main` carries the long-lived Radar integration
- `feature/*` branches start from `radar/main`

This keeps MCP-specific customizations isolated from upstream sync work.

When adding new Radar-specific logic, prefer additive layers such as:

- `src/radar/*`
- `src/mcp/*`
- `config/radar/*`
- `docs/radar/*`

## Transport

Implemented:

- stdio via `StdioServerTransport`

Deferred:

- remote Streamable HTTP

## Safety model

The server only accepts supplied artifacts and never:

- crawls a repo on its own
- fetches external URLs
- executes code
- invokes shell commands
- runs browser automation

## Why not API-first

An API-first design would expand compatibility surface before it adds product value. MCP-first keeps the fork aligned with the actual operator workflow and future ChatGPT MCP-style integration.
