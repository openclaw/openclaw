---
summary: "CLI-reference for `openclaw plugins` (liste, installér, aktivér/deaktivér, doctor)"
read_when:
  - Du vil installere eller administrere in-process Gateway-plugins
  - Du vil fejlfinde fejl ved indlæsning af plugins
title: "plugins"
---

# `openclaw plugins`

Administrér Gateway-plugins/udvidelser (indlæst in-process).

Relateret:

- Pluginsystem: [Plugins](/tools/plugin)
- Pluginmanifest + skema: [Plugin manifest](/plugins/manifest)
- Sikkerhedshærdning: [Security](/gateway/security)

## Kommandoer

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Bundtede plugins skib med OpenClaw men begynde deaktiveret. Brug 'plugins aktivere' til
aktivere dem.

Alle plugins skal sende en `openclaw.plugin.json` fil med en inline JSON Schema
(`configSchema`, selvom tom). Manglende / ugyldige manifester eller skemaer forhindrer
plugin i at indlæse og mislykkes config validering.

### Installér

```bash
openclaw plugins install <path-or-spec>
```

Sikkerhedsnote: behandl plugin installeres som kørende kode. Foretræk fastgjorte versioner.

Understøttede arkiver: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Brug `--link` for at undgå at kopiere en lokal mappe (tilføjer til `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

### Opdatér

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Opdateringer gælder kun for plugins installeret fra npm (sporet i `plugins.installs`).
