---
title: Sandbox-CLI
summary: "„Sandbox-Container verwalten und die effektive Sandbox-Richtlinie prüfen“"
read_when: "„Sie verwalten Sandbox-Container oder debuggen das Verhalten von Sandbox-/Tool-Richtlinien.“"
status: active
---

# Sandbox-CLI

Verwalten Sie Docker-basierte Sandbox-Container für die isolierte Ausführung von Agenten.

## Überblick

OpenClaw kann Agenten aus Sicherheitsgründen in isolierten Docker-Containern ausführen. Die `sandbox`-Befehle helfen Ihnen, diese Container zu verwalten, insbesondere nach Updates oder Konfigurationsänderungen.

## Befehle

### `openclaw sandbox explain`

Prüfen Sie den **effektiven** Sandbox-Modus/-Geltungsbereich/-Arbeitsbereichszugriff, die Sandbox-Werkzeugrichtlinie sowie erhöhte Gates (mit Fix-it-Konfigurationsschlüsselpfaden).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Listen Sie alle Sandbox-Container mit ihrem Status und ihrer Konfiguration auf.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**Die Ausgabe enthält:**

- Containername und -status (running/stopped)
- Docker-Image und ob es der Konfiguration entspricht
- Alter (Zeit seit Erstellung)
- Leerlaufzeit (Zeit seit letzter Nutzung)
- Zugeordnete Sitzung/Agent

### `openclaw sandbox recreate`

Entfernen Sie Sandbox-Container, um eine Neuerstellung mit aktualisierten Images/Konfigurationen zu erzwingen.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Optionen:**

- `--all`: Alle Sandbox-Container neu erstellen
- `--session <key>`: Container für eine bestimmte Sitzung neu erstellen
- `--agent <id>`: Container für einen bestimmten Agenten neu erstellen
- `--browser`: Nur Browser-Container neu erstellen
- `--force`: Bestätigungsabfrage überspringen

**Wichtig:** Container werden automatisch neu erstellt, wenn der Agent das nächste Mal verwendet wird.

## Verwende Fälle

### Nach dem Aktualisieren von Docker-Images

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### Nach dem Ändern der Sandbox-Konfiguration

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### Nach dem Ändern von setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### Nur für einen bestimmten Agenten

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Warum ist das erforderlich?

**Problem:** Wenn Sie Sandbox-Docker-Images oder die Konfiguration aktualisieren:

- Bestehende Container laufen mit alten Einstellungen weiter
- Container werden erst nach 24 Stunden Inaktivität bereinigt
- Regelmäßig genutzte Agenten halten alte Container unbegrenzt am Laufen

**Lösung:** Verwenden Sie `openclaw sandbox recreate`, um das Entfernen alter Container zu erzwingen. Sie werden bei Bedarf automatisch mit den aktuellen Einstellungen neu erstellt.

Tipp: Bevorzugen Sie `openclaw sandbox recreate` gegenüber manuellen `docker rm`. Es verwendet die Container-Benennung des Gateway und vermeidet Abweichungen, wenn sich Scope-/Sitzungsschlüssel ändern.

## Konfiguration

Sandbox-Einstellungen befinden sich in `~/.openclaw/openclaw.json` unter `agents.defaults.sandbox` (agentenspezifische Überschreibungen kommen in `agents.list[].sandbox`):

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

## Siehe auch

- [Sandbox-Dokumentation](/gateway/sandboxing)
- [Agenten-Konfiguration](/concepts/agent-workspace)
- [Doctor-Befehl](/gateway/doctor) – Sandbox-Setup prüfen
