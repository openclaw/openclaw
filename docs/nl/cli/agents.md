---
summary: "CLI-referentie voor `openclaw agents` (lijst, toevoegen, verwijderen, identiteit instellen)"
read_when:
  - Je wilt meerdere geïsoleerde agents (werkruimtes + routing + authenticatie)
title: "agents"
x-i18n:
  source_path: cli/agents.md
  source_hash: 30556d81636a9ad8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:08Z
---

# `openclaw agents`

Beheer geïsoleerde agents (werkruimtes + authenticatie + routing).

Gerelateerd:

- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)
- Agent workspace: [Agent workspace](/concepts/agent-workspace)

## Voorbeelden

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## Identiteitsbestanden

Elke agentwerkruimte kan een `IDENTITY.md` bevatten in de root van de werkruimte:

- Voorbeeldpad: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` leest vanuit de root van de werkruimte (of een expliciete `--identity-file`)

Avatarpaden worden relatief ten opzichte van de root van de werkruimte opgelost.

## Identiteit instellen

`set-identity` schrijft velden naar `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (pad relatief aan de werkruimte, http(s)-URL of data-URI)

Laden vanuit `IDENTITY.md`:

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

Velden expliciet overschrijven:

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

Config-voorbeeld:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "OpenClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/openclaw.png",
        },
      },
    ],
  },
}
```
