---
title: Sandbox CLI
summary: "Hantera sandbox-containrar och inspektera effektiv sandbox-policy"
read_when: "Du hanterar sandbox-containrar eller felsöker sandbox-/verktygspolicybeteende."
status: active
x-i18n:
  source_path: cli/sandbox.md
  source_hash: 6e1186f26c77e188
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:46Z
---

# Sandbox CLI

Hantera Docker-baserade sandbox-containrar för isolerad agentkörning.

## Översikt

OpenClaw kan köra agenter i isolerade Docker-containrar av säkerhetsskäl. Kommandona `sandbox` hjälper dig att hantera dessa containrar, särskilt efter uppdateringar eller konfigurationsändringar.

## Kommandon

### `openclaw sandbox explain`

Inspektera det **effektiva** sandbox-läget/omfånget/åtkomsten till arbetsyta, sandbox-verktygspolicy och upphöjda gates (med fix-it-konfigurationsnyckelsökvägar).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Lista alla sandbox-containrar med deras status och konfiguration.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**Utdata inkluderar:**

- Containernamn och status (körs/stoppad)
- Docker-avbildning och om den matchar konfigurationen
- Ålder (tid sedan skapande)
- Inaktiv tid (tid sedan senaste användning)
- Associerad session/agent

### `openclaw sandbox recreate`

Ta bort sandbox-containrar för att tvinga återskapande med uppdaterade avbildningar/konfiguration.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Alternativ:**

- `--all`: Återskapa alla sandbox-containrar
- `--session <key>`: Återskapa container för specifik session
- `--agent <id>`: Återskapa containrar för specifik agent
- `--browser`: Återskapa endast webbläsarcontainrar
- `--force`: Hoppa över bekräftelseprompt

**Viktigt:** Containrar återskapas automatiskt när agenten används nästa gång.

## Användningsfall

### Efter uppdatering av Docker-avbildningar

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### Efter ändring av sandbox-konfiguration

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### Efter ändring av setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### Endast för en specifik agent

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Varför behövs detta?

**Problem:** När du uppdaterar Docker-avbildningar eller konfiguration för sandbox:

- Befintliga containrar fortsätter att köras med gamla inställningar
- Containrar rensas först efter 24 timmars inaktivitet
- Agenter som används regelbundet behåller gamla containrar igång på obestämd tid

**Lösning:** Använd `openclaw sandbox recreate` för att tvinga borttagning av gamla containrar. De återskapas automatiskt med aktuella inställningar när de behövs nästa gång.

Tips: föredra `openclaw sandbox recreate` framför manuell `docker rm`. Det använder
Gateway:s containernamngivning och undviker avvikelser när scope-/sessionsnycklar ändras.

## Konfiguration

Sandbox-inställningar finns i `~/.openclaw/openclaw.json` under `agents.defaults.sandbox` (per-agent-åsidosättningar finns i `agents.list[].sandbox`):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## Se även

- [Sandbox-dokumentation](/gateway/sandboxing)
- [Agentkonfiguration](/concepts/agent-workspace)
- [Doctor-kommandot](/gateway/doctor) – Kontrollera sandbox-konfigurationen
