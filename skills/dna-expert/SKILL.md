---
name: dna-expert
description: Expert assistant for DNA (Moltbot) self-hosted AI assistant development, configuration, troubleshooting, and coding. Use when working with DNA installation, configuration (dna.json), multi-agent setups, channel integration (WhatsApp, Telegram, Discord, Slack, Signal, iMessage), Lobster workflows, memory architecture, skill development, or troubleshooting gateway/channel issues. Covers Mac installation, LaunchAgent setup, model configuration, secrets management, cron scheduling, and the 565+ community skill ecosystem.
---

# DNA Expert Skill

DNA is a self-hosted AI assistant bridging chat apps (WhatsApp, Telegram, Discord, Slack, Signal, iMessage) with LLMs like Claude. With 51,400+ GitHub stars and active development (v2.0.0-beta5, January 2026), it's the leading open-source solution for deploying personal AI agents. Recently renamed to "Moltbot" at Anthropic's request, though CLI remains `dna`.

## Quick Reference

**Config location:** `~/.dna/dna.json` (JSON5 format)  
**Workspace:** `~/clawd` (customizable per agent)  
**Logs:** `/tmp/dna/dna-YYYY-MM-DD.log`  
**Gateway port:** 18789 (default)  
**Node requirement:** 22+

## Installation (Mac)

```bash
# Quick install (recommended)
curl -fsSL https://clawd.bot/install.sh | bash

# Then run onboarding wizard
dna onboard --install-daemon
```

Alternative methods: `npm install -g dna@latest` or build from source.

See [references/installation.md](references/installation.md) for detailed setup and prerequisites.

## Essential Commands

```bash
dna status              # Quick overview
dna status --all        # Full diagnosis (safe to share)
dna doctor              # Validate config/state
dna doctor --fix        # Auto-repair issues
dna logs --follow       # Real-time log monitoring
dna channels status --probe  # Test channel connections
dna health --json       # Gateway reachability
```

## Minimal Configuration

```json
{
  "agents": { "defaults": { "workspace": "~/clawd" } },
  "channels": { "whatsapp": { "allowFrom": ["+15555550123"] } }
}
```

See [references/configuration.md](references/configuration.md) for complete schema, environment variables, secrets management, and multi-agent setup.

## Model Configuration

**Recommended production setup:**

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-5",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openrouter/deepseek/deepseek-r1:free"]
      },
      "thinkingDefault": "low",
      "contextTokens": 200000
    }
  }
}
```

**Supported providers:** Anthropic, OpenAI, OpenRouter (free tier available), Google Gemini, Amazon Bedrock, MiniMax, Z.AI/GLM, local models via Ollama/LM Studio.

Claude Opus 4.5 recommended as primary for superior prompt-injection resistance.

## Workspace Files

Create these in your workspace directory:

- `AGENTS.md` — Agent instructions and capabilities
- `SOUL.md` — Personality definition
- `USER.md` — Your preferences and context
- `MEMORY.md` — Long-term memories

## Troubleshooting

See [references/troubleshooting.md](references/troubleshooting.md) for common issues and fixes including:

- Gateway startup failures
- WhatsApp disconnection issues
- "All models failed" errors
- Gateway Dashboard webchat slash commands not working
- Nuclear reset procedure

**Quick fixes:**

```bash
# Gateway won't start
dna doctor --fix
lsof -nP -iTCP:18789 -sTCP:LISTEN  # Check port conflict

# WhatsApp disconnected
dna channels logout
rm -rf ~/.dna/credentials
dna channels login --verbose

# Nuclear reset (loses all sessions)
dna gateway stop
rm -rf ~/.dna
dna onboard --install-daemon
```

## Multi-Agent Architecture

For running multiple businesses with isolated agents:

```json
{
  "agents": {
    "list": [
      { "id": "store1", "name": "Fashion", "workspace": "~/clawd-fashion" },
      { "id": "store2", "name": "Electronics", "workspace": "~/clawd-electronics" },
      { "id": "personal", "default": true, "workspace": "~/clawd-personal" }
    ]
  },
  "bindings": [
    { "agentId": "store1", "match": { "channel": "whatsapp", "accountId": "fashion-biz" } },
    { "agentId": "store2", "match": { "channel": "whatsapp", "accountId": "electronics-biz" } }
  ]
}
```

See [references/multi-agent.md](references/multi-agent.md) for routing priority and e-commerce patterns.

## Skills System

Skills follow Anthropic's Agent Skill convention—directories with `SKILL.md` containing YAML frontmatter.

**Loading precedence:**
1. `<workspace>/skills` — Per-agent
2. `~/.dna/skills` — Shared
3. Bundled skills

**Install community skills:**

```bash
npx clawdhub@latest install <skill-slug>
```

See [references/skills.md](references/skills.md) for creating custom skills and notable community skills.

## Memory Architecture

Memory is plain Markdown in workspace—Obsidian compatible, git-versionable.

**Memory layers:**
- `MEMORY.md` — Curated long-term facts
- `memory/YYYY-MM-DD.md` — Daily logs (today + yesterday auto-loaded)

**Vector search config:**

```json
{
  "memorySearch": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "query": { "hybrid": { "enabled": true, "vectorWeight": 0.7, "textWeight": 0.3 } }
  }
}
```

See [references/memory.md](references/memory.md) for storage locations and Obsidian integration.

## Lobster Workflows

Deterministic workflow system with approval gates.

**Enable:**

```json
{ "tools": { "alsoAllow": ["lobster"] } }
```

**Workflow structure (.lobster YAML):**

```yaml
name: inbox-triage
steps:
  - id: collect
    command: inbox list --json
  - id: approve
    command: inbox apply --approve
    stdin: $collect.stdout
    approval: required
```

**Cron scheduling:**

```bash
moltbot cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --deliver --channel whatsapp --to "+15551234567"
```

See [references/workflows.md](references/workflows.md) for complete Lobster and cron documentation.

## Security Best Practices

- Run on dedicated hardware (Mac Mini ideal)
- Set `gateway.bind: "loopback"` to prevent external exposure
- Default DM policy to "pairing" mode
- Enable sandbox mode for group chats
- Use Tailscale for secure remote access

## Resource Requirements

| Use Case | RAM | Storage |
|----------|-----|---------|
| Basic chat | 2GB | 20GB |
| Browser automation | 4GB+ | 50GB |
| Production multi-agent | 4-8GB | 100GB |

## Key Insights

1. **Start with Claude Opus 4.5** — Prompt-injection resistance matters more than cost savings when agent has system access
2. **Git your workspace from day one** — Agent memory and personality become valuable IP
3. **Use Lobster with approval gates** — Determinism and auditability worth the setup investment
4. **Use `--session isolated` for cron** — Prevents context buildup in main conversation

## Community Resources

- **ClawdHub registry:** https://clawdhub.com
- **Awesome list:** https://github.com/VoltAgent/awesome-moltbot-skills (565+ skills)
- **Discord:** 8,900+ members, two DNA instances answering questions live
