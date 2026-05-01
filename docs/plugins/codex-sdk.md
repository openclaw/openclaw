---
title: Codex SDK Runtime
description: Native OpenClaw ACP runtime powered by the official Codex SDK.
---

The bundled `codex-sdk` plugin makes Codex a first-class OpenClaw runtime. It
uses `@openai/codex-sdk`, registers the `codex-sdk` ACP backend, and exposes
Codex through the normal OpenClaw agent, Gateway, CLI, command, and Control UI
surfaces.

## Install

```bash
codex login
openclaw plugins install --link ./extensions/codex-sdk
openclaw config set plugins.allow '["codex-sdk"]'
openclaw codex configure
openclaw codex config validate
openclaw codex doctor --record
```

`openclaw codex configure` enables the ACP backend, sets `acp.backend` to
`codex-sdk`, and creates a first-class `codex` agent entry.

## Routes

Default route aliases:

- `codex`
- `codex-fast`
- `codex-deep`
- `codex-review`
- `codex-test`
- `codex-refactor`
- `codex-docs`
- `codex-ship`
- `codex-worker`

Inspect the effective model and reasoning settings with:

```bash
openclaw codex routes
openclaw codex sessions
```

The Control UI `Codex` tab also shows effective route and session metadata.

## Model

Configure model and reasoning effort through plugin config:

```bash
openclaw config set plugins.entries.codex-sdk.config.model gpt-5.5
openclaw config set plugins.entries.codex-sdk.config.modelReasoningEffort xhigh
openclaw codex config validate
openclaw codex routes
```

OpenClaw forwards the configured model string to the Codex SDK. Codex account
entitlement and login remain owned by Codex itself.

## Backchannel

The plugin injects an MCP server into Codex SDK turns as
`mcp_servers.openclaw-codex`. Codex gets:

- `openclaw_status`
- `openclaw_proposal`
- `openclaw_gateway_request`

Read/status methods and proposal writes are allowed by default. Broader Gateway
writes require explicit `backchannel.allowedMethods` configuration and the
token named by `backchannel.writeTokenEnv`.

## Smoke Test

```bash
pnpm smoke:codex-sdk
OPENCLAW_CODEX_LIVE_SMOKE=1 pnpm smoke:codex-sdk
```

The live smoke starts an isolated loopback Gateway, sends one real OpenClaw
agent turn through Codex, and verifies that Codex can call the OpenClaw MCP
backchannel.
