# Codex SDK Runtime

The `codex-sdk` plugin is OpenClaw's native Codex runtime. It uses the official
`@openai/codex-sdk` package, registers a `codex-sdk` ACP backend, and wires
Codex into the normal OpenClaw agent, Gateway, CLI, command, and Control UI
surfaces.

This plugin is standalone. It does not depend on AirLock or Wanda, and it is
intended to be useful to any OpenClaw operator who wants Codex to power an
OpenClaw agent.

## What It Adds

- First-class ACP agents for `codex`, `codex-fast`, `codex-deep`,
  `codex-review`, `codex-test`, `codex-refactor`, `codex-docs`,
  `codex-ship`, and `codex-worker`.
- Persistent Codex sessions with streamed text, tool/status events, attachments,
  event replay, session export, and compatibility records.
- CLI commands under `openclaw codex ...` for status, route inspection, config
  validation, doctor checks, one-shot runs, events, exports, and proposal inbox
  management.
- Gateway RPC methods under `codex.*`.
- A Control UI `Codex` tab for health, routes, proposal inbox work, execution,
  recent sessions, and event replay.
- A bidirectional OpenClaw MCP backchannel injected into Codex turns.

## Authentication

Codex auth stays with Codex. Sign in once:

```bash
codex login
```

After that, OpenClaw reuses the local Codex CLI/OAuth session through the SDK.
OpenClaw does not run a second OpenAI Codex OAuth flow for this plugin.

For service deployments that intentionally avoid the local Codex login, set the
plugin `apiKeyEnv` option to the name of an environment variable that contains
the API key.

## Model And Route Visibility

The plugin passes the configured model and reasoning effort directly into the
Codex SDK thread options. OpenClaw shows the effective values in three places:

- Control UI: open the `Codex` tab and inspect `Routes` or `Sessions`.
- CLI: run `openclaw codex routes` or `openclaw codex sessions`.
- Gateway RPC: call `codex.routes`, `codex.status`, or `codex.sessions`.

Example highest-effort route:

```bash
openclaw config set plugins.entries.codex-sdk.config.model gpt-5.5
openclaw config set plugins.entries.codex-sdk.config.modelReasoningEffort xhigh
openclaw config set plugins.entries.codex-sdk.config.routes.default.model gpt-5.5
openclaw config set plugins.entries.codex-sdk.config.routes.default.modelReasoningEffort xhigh
openclaw codex config validate
openclaw codex routes
```

There is no separate OpenClaw "Pro" switch. The model string is forwarded to
the SDK, and account entitlement remains part of the Codex/OpenAI login. If
Codex exposes a different model id for a Pro tier, change the `model` string and
rerun `openclaw codex routes` to verify the effective route.

## Install From This Repository

```bash
pnpm install
openclaw plugins install --link ./extensions/codex-sdk
openclaw config set plugins.allow '["codex-sdk"]'
openclaw codex configure
openclaw codex config validate
openclaw codex doctor --record
```

`openclaw codex configure` sets `acp.backend = "codex-sdk"` and creates a
first-class `agents.list[]` entry for the `codex` agent. Once configured, normal
OpenClaw agent surfaces can route directly to Codex.

## Standalone Gateway Smoke

Use the repo smoke script for a clean, isolated profile that does not touch the
default Gateway or any existing Wanda/AirLock profile:

```bash
pnpm smoke:codex-sdk
```

The default smoke validates config, configures the plugin in a temporary
profile, runs doctor, and reads plugin status. It does not start a model turn.

To prove the full user-facing loop, opt into the live smoke:

```bash
OPENCLAW_CODEX_LIVE_SMOKE=1 pnpm smoke:codex-sdk
```

The live smoke starts a loopback-only standalone Gateway, sends one OpenClaw
`agent` RPC through the `codex` ACP agent, requires Codex to call the
`openclaw_status` MCP backchannel, verifies that the tool completed, and then
shuts the Gateway down.

Useful overrides:

```bash
OPENCLAW_CODEX_SMOKE_PORT=19891
OPENCLAW_CODEX_SMOKE_ROOT=/tmp/openclaw-codex-sdk-smoke
OPENCLAW_CODEX_SMOKE_CWD=/path/to/workspace
OPENCLAW_CODEX_SMOKE_KEEP_STATE=1
OPENCLAW_CODEX_SMOKE_VERBOSE=1
```

## Manual Standalone Gateway

This mirrors the live smoke but leaves the Gateway available for manual testing:

```bash
export OPENCLAW_STATE_DIR=/tmp/openclaw-codex-standalone/state
export OPENCLAW_CONFIG_PATH=/tmp/openclaw-codex-standalone/openclaw.json
export OPENCLAW_SKIP_CHANNELS=1
export CLAWDBOT_SKIP_CHANNELS=1

openclaw plugins install --link ./extensions/codex-sdk
openclaw config set plugins.allow '["codex-sdk"]'
openclaw config set plugins.entries.codex-sdk.config.cwd "$PWD"
openclaw codex configure
openclaw config set 'agents.list[0].runtime.acp.cwd' "$PWD"
openclaw codex config validate

openclaw gateway run --port 19891 --auth none --bind loopback --compact
```

From another terminal:

```bash
openclaw gateway call agent \
  --url ws://127.0.0.1:19891 \
  --token smoke \
  --expect-final \
  --timeout 300000 \
  --json \
  --params '{"agentId":"codex","sessionKey":"agent:codex:main","message":"Use openclaw_status, then reply with STANDALONE_CODEX_GATEWAY_OK."}'
```

`--auth none` should only be used on loopback test gateways.

## Bidirectional Backchannel

The plugin injects an MCP server into SDK-backed Codex turns as
`mcp_servers.openclaw-codex`. Codex gets these tools:

- `openclaw_status`: read Codex/OpenClaw runtime status.
- `openclaw_proposal`: create operator-visible proposal inbox records.
- `openclaw_gateway_request`: call explicitly allowlisted Gateway RPC methods.

The generated backchannel is approved in Codex config because SDK turns are
non-interactive. OpenClaw still enforces the actual safety boundary:

- read methods are limited to the configured `backchannel.readMethods`
- proposal writes are limited to safe proposal methods by default
- broader Gateway writes require `backchannel.allowedMethods`
- write/admin calls require the token named by
  `OPENCLAW_CODEX_BACKCHANNEL_WRITE_TOKEN` unless explicitly disabled

## Release Checks

Before publishing this plugin, run:

```bash
pnpm smoke:codex-sdk
OPENCLAW_CODEX_LIVE_SMOKE=1 pnpm smoke:codex-sdk
pnpm exec vitest run extensions/codex-sdk/src/*.test.ts src/commands/agent.acp.test.ts
pnpm exec tsgo --noEmit
pnpm build:strict-smoke
```

The plugin package and manifest carry the standalone version
`2026.5.1`. Root release notes are tracked in `CHANGELOG.md` under
`Unreleased`.
