---
summary: "CLI-reference for `openclaw plugins` (liste, installér, aktivér/deaktivér, doctor)"
read_when:
  - Du vil installere eller administrere in-process Gateway-plugins
  - Du vil fejlfinde fejl ved indlæsning af plugins
title: "plugins"
x-i18n:
  source_path: cli/plugins.md
  source_hash: 60476e0a9b7247bd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:00Z
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

Medfølgende plugins leveres med OpenClaw, men starter deaktiveret. Brug `plugins enable` til
at aktivere dem.

Alle plugins skal levere en `openclaw.plugin.json`-fil med et indlejret JSON Schema
(`configSchema`, også selv om det er tomt). Manglende/ugyldige manifester eller skemaer forhindrer,
at pluginet indlæses og får konfigurationsvalidering til at fejle.

### Installér

```bash
openclaw plugins install <path-or-spec>
```

Sikkerhedsnote: betragt plugin-installationer som kørsel af kode. Foretræk fastlåste versioner.

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
