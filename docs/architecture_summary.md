<!-- Authored by: cc (Claude Code) | 2026-03-13 -->

# OpenClaw Architecture Summary

## Modules

- **CLI** (`src/entry.ts` -> `src/cli/`): Entry point, argument parsing, command dispatch via `createDefaultDeps` DI pattern.
- **Gateway** (`src/gateway/`): Central orchestrator — boots channels, authenticates requests, rate-limits, routes messages to agents, manages channel health.
- **Channels** (`src/channels/`, `src/discord/`, `src/telegram/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/web/`): Built-in messaging integrations. Each channel handles transport, message normalization, and delivery.
- **Extensions** (`extensions/`): Plugin-packaged channels and providers (MS Teams, Matrix, IRC, Ollama, etc.). Each is an independent workspace package with its own `package.json`. Runtime loads via `src/plugin-sdk/`.
- **Routing** (`src/routing/`): Resolves incoming messages to target agent/model based on account ID, channel bindings, and config.
- **Agents** (`src/agents/`): Spawns and manages agent processes, handles events (tool calls, streaming, completion).
- **Media** (`src/media/`, `src/media-understanding/`): Fetch, transcode, and analyze media (images, audio, video) via Anthropic, Google, Deepgram providers.
- **Config** (`src/config/`): Loads `openclaw.json` + env, manages sessions, secrets, and credential stores.
- **Infra** (`src/infra/`): Low-level utilities — port management, binary resolution, env normalization, error handling, runtime guards.

## Channel Architecture

Built-in channels live in `src/` (Telegram, Discord, Slack, Signal, iMessage, WhatsApp/web). Extension channels live in `extensions/` and register via `src/plugin-sdk/`. Both share the same routing, allowlist, and command-gating infrastructure in `src/channels/`.

## Skill System

Skills are bundled tool packages in `skills/`. Each skill has a `SKILL.md` (prompt context) + metadata. The gateway injects relevant skill context into agent prompts at runtime.

## Build Pipeline

`pnpm build` runs tsdown (`tsdown.config.ts`) -> `dist/`. Type checking via `pnpm tsgo`. Linting/formatting via Oxlint + Oxfmt (`pnpm check`). Tests via Vitest with V8 coverage thresholds.

## Key Data Flows

1. **Message in**: Channel receives message -> gateway authenticates -> routing resolves account/agent -> gateway calls agent.
2. **Agent execution**: Agent process spawns -> receives prompt (system + skills + user message) -> streams response -> tool calls dispatched -> final reply delivered back through channel.
3. **Extension loading**: Gateway discovers extensions in `extensions/` -> loads via plugin SDK -> registers channels/providers into the channel dock.
