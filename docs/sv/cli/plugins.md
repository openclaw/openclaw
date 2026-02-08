---
summary: "CLI-referens för `openclaw plugins` (lista, installera, aktivera/inaktivera, doctor)"
read_when:
  - Du vill installera eller hantera in-process Gateway-plugins
  - Du vill felsöka fel vid laddning av plugins
title: "plugins"
x-i18n:
  source_path: cli/plugins.md
  source_hash: 60476e0a9b7247bd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:45Z
---

# `openclaw plugins`

Hantera Gateway (nätverksgateway)-plugins/tillägg (laddas in-process).

Relaterat:

- Plugin-system: [Plugins](/tools/plugin)
- Pluginmanifest + schema: [Pluginmanifest](/plugins/manifest)
- Säkerhetshärdning: [Säkerhet](/gateway/security)

## Kommandon

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Medföljande plugins levereras med OpenClaw men startar inaktiverade. Använd `plugins enable` för att
aktivera dem.

Alla plugins måste levereras med en `openclaw.plugin.json`-fil med ett inbäddat JSON Schema
(`configSchema`, även om det är tomt). Saknade/ogiltiga manifest eller scheman förhindrar
att pluginen laddas och gör att konfigvalideringen misslyckas.

### Installera

```bash
openclaw plugins install <path-or-spec>
```

Säkerhetsnotering: behandla plugininstallationer som att köra kod. Föredra pinnade versioner.

Stödda arkiv: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Använd `--link` för att undvika att kopiera en lokal katalog (lägger till i `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

### Uppdatera

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Uppdateringar gäller endast plugins som installerats från npm (spåras i `plugins.installs`).
