# Team Worklog

## 2026-02-02
- Goal: enforce Pulse identity in system prompts (CLI + embedded) and keep it on resume turns.
- Branch: fix/assistant-identity-default
- Commit: 4c93a1b99bba66185b071c935e7c2d62d149bf8f
- Tests (local): pnpm vitest run src/agents/system-prompt.test.ts src/agents/cli-runner.test.ts

Changes (repo)
- New identity prompt resolver: src/agents/identity-prompt.ts
- System prompt now includes an Identity section and a strong identity line.
- CLI resume always keeps systemPromptArg when provided.

Deploy (Tagers / Vultr)
- Host: OpenClaw-Tagers (ssh root@100.117.108.5, requires Tailscale)
- Docker compose: /opt/tagers/openclaw/docker-compose.yml
- Build repo: /opt/tagers/openclaw/openclaw-src (branch fix/assistant-identity-default)
- Mount dist into container:
  - /opt/tagers/openclaw/openclaw-src/dist:/app/dist:ro
- Config:
  - /opt/tagers/openclaw/config/prod/clawdbot.json
  - agents.defaults.cliBackends.claude-cli.systemPromptWhen = "always"
  - Do NOT set agents.defaults.identity (schema rejects it)
- Workspace identity file used by default agent:
  - /opt/tagers/openclaw/openclaw-data/workspace/IDENTITY.md
- Restart:
  - cd /opt/tagers/openclaw && docker compose restart openclaw-prod

Webchat
- URL: https://openclaw-tagers.tail81772f.ts.net/chat?session=global

