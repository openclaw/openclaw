---
summary: "CLI-Referenz für `openclaw plugins` (Auflisten, Installieren, Aktivieren/Deaktivieren, Diagnose)"
read_when:
  - Sie möchten In-Process-Gateway-Plugins installieren oder verwalten
  - Sie möchten Fehler beim Laden von Plugins debuggen
title: "Plugins"
---

# `openclaw plugins`

Verwalten Sie Gateway-Plugins/-Erweiterungen (im Prozess geladen).

Verwandt:

- Plugin-System: [Plugins](/tools/plugin)
- Plugin-Manifest + Schema: [Plugin-Manifest](/plugins/manifest)
- Sicherheits-Härtung: [Security](/gateway/security)

## Befehle

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Gebündelte Plugins werden mit OpenClaw ausgeliefert, starten jedoch deaktiviert. Verwenden Sie `plugins enable`, um sie zu aktivieren.

Alle Plugins müssen eine Datei `openclaw.plugin.json` mit einem eingebetteten JSON-Schema (`configSchema`, auch wenn leer) enthalten. Fehlende/ungültige Manifeste oder Schemata verhindern das Laden des Plugins und lassen die Konfigurationsvalidierung fehlschlagen.

### Installieren

```bash
openclaw plugins install <path-or-spec>
```

Sicherheitshinweis: Behandeln Sie Plugin-Installationen wie das Ausführen von Code. Bevorzugen Sie gepinnte Versionen.

Unterstützte Archive: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Verwenden Sie `--link`, um das Kopieren eines lokalen Verzeichnisses zu vermeiden (fügt zu `plugins.load.paths` hinzu):

```bash
openclaw plugins install -l ./my-plugin
```

### Aktualisieren

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Aktualisierungen gelten nur für Plugins, die von npm installiert wurden (nachverfolgt in `plugins.installs`).
