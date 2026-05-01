# Changelog

## 2026.5.1

- Added the standalone `codex-sdk` OpenClaw plugin backed by
  `@openai/codex-sdk`.
- Added first-class Codex ACP routes for default, fast, deep, review, test,
  refactor, docs, ship, and worker workflows.
- Added Gateway RPC methods, `/codex` chat commands, `openclaw codex` CLI
  commands, and a Control UI Codex tab.
- Added persistent session/event state, replay, export, compatibility records,
  and proposal inbox execution.
- Added a bidirectional MCP backchannel so Codex can read OpenClaw status,
  create proposals, and call explicitly allowlisted Gateway methods.
- Added isolated smoke coverage for config, doctor, status, and optional live
  end-to-end Gateway turns.
- Added effective model and reasoning visibility for routes and sessions.
