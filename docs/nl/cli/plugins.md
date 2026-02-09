---
summary: "CLI-referentie voor `openclaw plugins` (lijst, installeren, in-/uitschakelen, diagnose)"
read_when:
  - Je wilt in-process Gateway-plugins installeren of beheren
  - Je wilt fouten bij het laden van plugins debuggen
title: "plugins"
---

# `openclaw plugins`

Beheer Gateway-plugins/extensies (in-process geladen).

Gerelateerd:

- Pluginsysteem: [Plugins](/tools/plugin)
- Pluginmanifest + schema: [Plugin manifest](/plugins/manifest)
- Beveiligingsverharding: [Security](/gateway/security)

## Commands

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Gebundelde plugins worden met OpenClaw geleverd maar starten uitgeschakeld. Gebruik `plugins enable` om ze
te activeren.

Alle plugins moeten een `openclaw.plugin.json`-bestand meeleveren met een inline JSON Schema
(`configSchema`, zelfs als het leeg is). Ontbrekende/ongeldige manifesten of schema’s voorkomen
dat de plugin wordt geladen en laten de configvalidatie falen.

### Installeren

```bash
openclaw plugins install <path-or-spec>
```

Beveiligingsopmerking: behandel plugininstallaties alsof je code uitvoert. Geef de voorkeur aan vastgepinde versies.

Ondersteunde archieven: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Gebruik `--link` om het kopiëren van een lokale map te vermijden (voegt toe aan `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

### Bijwerken

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Updates zijn alleen van toepassing op plugins die via npm zijn geïnstalleerd (bijgehouden in `plugins.installs`).
