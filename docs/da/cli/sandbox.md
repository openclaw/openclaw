---
title: Sandbox CLI
summary: "Administrér sandbox-containere og inspicér den effektive sandbox-politik"
read_when: "Du administrerer sandbox-containere eller fejlsøger sandbox-/tool-policy-adfærd."
status: active
---

# Sandbox CLI

Administrér Docker-baserede sandbox-containere til isoleret agentkørsel.

## Overblik

OpenClaw kan køre agenter i isolerede Docker containere for sikkerhed. Kommandoerne `sandbox` hjælper dig med at håndtere disse containere, især efter opdateringer eller konfigurationsændringer.

## Kommandoer

### `openclaw sandbox explain`

Inspicér den **effektive** sandbox-tilstand/-scope/-workspace-adgang, sandbox-værktøjspolitik og forhøjede gates (med fix-it-konfigurationsnøglestier).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Vis alle sandbox-containere med deres status og konfiguration.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**Output inkluderer:**

- Containernavn og status (kører/stoppet)
- Docker-image og om det matcher konfigurationen
- Alder (tid siden oprettelse)
- Inaktiv tid (tid siden sidste brug)
- Tilknyttet session/agent

### `openclaw sandbox recreate`

Fjern sandbox-containere for at gennemtvinge genskabelse med opdaterede images/konfiguration.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Indstillinger:**

- `--all`: Genskab alle sandbox-containere
- `--session <key>`: Genskab container for en specifik session
- `--agent <id>`: Genskab containere for en specifik agent
- `--browser`: Genskab kun browser-containere
- `--force`: Spring bekræftelsesprompt over

**Vigtigt:** Containere genskabes automatisk, næste gang agenten bruges.

## Anvendelsestilfælde

### Efter opdatering af Docker-images

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### Efter ændring af sandbox-konfiguration

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### Efter ændring af setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### Kun for en specifik agent

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Hvorfor er dette nødvendigt?

**Problem:** Når du opdaterer sandbox Docker-images eller konfiguration:

- Eksisterende containere fortsætter med at køre med gamle indstillinger
- Containere ryddes først efter 24 timers inaktivitet
- Agenter, der bruges regelmæssigt, holder gamle containere kørende på ubestemt tid

**Løsning:** Brug `openclaw sandkasse genskabelse` for at tvinge fjernelse af gamle containere. De genskabes automatisk med aktuelle indstillinger, når det næste er nødvendigt.

Tip: foretrækker `openclaw sandbox genskabelse` over manuel `docker rm`. Det bruger
Gateway ‘ s container navngivning og undgår mismatch når omfang / session nøgler ændres.

## Konfiguration

Sandbox-indstillinger findes i `~/.openclaw/openclaw.json` under `agents.defaults.sandbox` (per-agent-overskrivelser placeres i `agents.list[].sandbox`):

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

## Se også

- [Sandbox-dokumentation](/gateway/sandboxing)
- [Agentkonfiguration](/concepts/agent-workspace)
- [Doctor-kommando](/gateway/doctor) – Tjek sandbox-opsætning
