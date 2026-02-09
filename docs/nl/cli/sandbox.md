---
title: Sandbox CLI
summary: "Beheer sandboxcontainers en inspecteer het effectieve sandboxbeleid"
read_when: "Je beheert sandboxcontainers of debugt sandbox-/toolbeleidsgedrag."
status: active
---

# Sandbox CLI

Beheer op Docker gebaseerde sandboxcontainers voor geïsoleerde agentuitvoering.

## Overzicht

OpenClaw kan agents uitvoeren in geïsoleerde Dockercontainers voor beveiliging. De `sandbox`-opdrachten helpen je deze containers te beheren, vooral na updates of configuratiewijzigingen.

## Commands

### `openclaw sandbox explain`

Inspecteer de **effectieve** sandboxmodus/-scope/werkruimte-toegang, het sandbox-toolbeleid en verhoogde gates (met fix-it-config-sleutelpaden).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Toon alle sandboxcontainers met hun status en configuratie.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**Uitvoer bevat:**

- Containernaam en status (actief/gestopt)
- Dockerimage en of deze overeenkomt met de config
- Leeftijd (tijd sinds aanmaken)
- Inactieve tijd (tijd sinds laatste gebruik)
- Gekoppelde sessie/agent

### `openclaw sandbox recreate`

Verwijder sandboxcontainers om heraanmaak met bijgewerkte images/config af te dwingen.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Opties:**

- `--all`: Hermaak alle sandboxcontainers
- `--session <key>`: Hermaak container voor specifieke sessie
- `--agent <id>`: Hermaak containers voor specifieke agent
- `--browser`: Hermaak alleen browsercontainers
- `--force`: Sla bevestigingsprompt over

**Belangrijk:** Containers worden automatisch opnieuw aangemaakt wanneer de agent de volgende keer wordt gebruikt.

## Use Cases

### Na het bijwerken van Dockerimages

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### Na het wijzigen van de sandboxconfiguratie

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### Na het wijzigen van setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### Alleen voor een specifieke agent

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Waarom is dit nodig?

**Probleem:** Wanneer je sandbox-Dockerimages of -configuratie bijwerkt:

- Bestaande containers blijven draaien met oude instellingen
- Containers worden pas na 24 uur inactiviteit opgeschoond
- Regelmatig gebruikte agents houden oude containers onbeperkt draaiend

**Oplossing:** Gebruik `openclaw sandbox recreate` om het verwijderen van oude containers af te dwingen. Ze worden automatisch opnieuw aangemaakt met de huidige instellingen wanneer ze weer nodig zijn.

Tip: geef de voorkeur aan `openclaw sandbox recreate` boven handmatige `docker rm`. Dit gebruikt de containerbenaming van de Gateway en voorkomt mismatches wanneer scope-/sessiesleutels veranderen.

## Configuratie

Sandboxinstellingen staan in `~/.openclaw/openclaw.json` onder `agents.defaults.sandbox` (per-agent overrides staan in `agents.list[].sandbox`):

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

## Zie ook

- [Sandboxdocumentatie](/gateway/sandboxing)
- [Agentconfiguratie](/concepts/agent-workspace)
- [Doctor-opdracht](/gateway/doctor) - Controleer sandboxinstallatie
