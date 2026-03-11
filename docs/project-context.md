---
summary: "Canonical shared project context for clawdbot — structure, commands, contributor guidance, and cross-repo references"
read_when:
  - "starting a new session in Claude, Codex, Gemini, or a local LLM"
  - "looking up repo structure, commands, or where contributor guidance lives"
---

# Project Context

## Project

`clawdbot` is the OpenClaw gateway and CLI source repo. It owns the core runtime, channel integrations, CLI commands, media pipeline, and plugin/extension architecture.

## Core facts

- Source code lives in `src/`
- Tests are colocated `*.test.ts`
- Durable docs live in `docs/`
- Plugins/extensions live in `extensions/*`
- Runtime config lives in `~/.openclaw`
- Related hub strategy/docs live in `~/programming_projects/lionroot-openclaw`

## Structure

```text
src/            ← gateway, CLI, routing, channels, media, infra
extensions/     ← channel plugins and extension packages
docs/           ← durable docs, contributor guides, concepts, reference
apps/           ← native/mobile app surfaces
scripts/        ← release, packaging, maintenance helpers
```

## Common commands

```bash
pnpm install
pnpm build
pnpm check
pnpm test
pnpm test:coverage
pnpm openclaw ...
```

## Read next

- `docs/contributor/ai-tooling.md` — repo adapter rules, build/test, docs, workflow gate, multi-agent safety
- `docs/concepts/context.md` — how runtime context is assembled and why it matters
- `docs/concepts/multi-agent.md` — routing/workspace model
- `docs/cli/acp.md` — ACP-aware clients and tool flows
- `docs/automation/auth-monitoring.md` — Claude/Codex auth monitoring context
- `docs/start/docs-directory.md` — docs hub
- `docs/reference/AGENTS.default.md` — workspace bootstrap template (different from repo-root adapters)

## Related repos

- `~/.openclaw` — runtime config, credentials, cron, workspace state
- `~/clawd/openclaw-cli-proxy` — model routing proxy
- `~/clawd/ClawRouter` — prompt classification
- `~/programming_projects/lionroot-openclaw` — architecture, strategy, command-post hub

## Tool entry points

- `AGENTS.md` — Codex / OpenAI tooling adapter
- `CLAUDE.md` — Claude Code adapter
- `GEMINI.md` — Gemini adapter
- For tools without a special root filename, start here.
