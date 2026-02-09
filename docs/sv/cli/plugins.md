---
summary: "CLI-referens för `openclaw plugins` (lista, installera, aktivera/inaktivera, doctor)"
read_when:
  - Du vill installera eller hantera in-process Gateway-plugins
  - Du vill felsöka fel vid laddning av plugins
title: "plugins"
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

Paketerade plugins fartyg med OpenClaw men start inaktiverad. Använd `plugins enable` för att
aktivera dem.

Alla plugins måste skicka en `openclaw.plugin.json`-fil med en inline JSON Schema
(`configSchema`, även om den är tom). Saknade/ogiltiga manifest eller scheman hindrar
pluginen från att ladda och misslyckas validering av konfigurationen.

### Installera

```bash
openclaw plugins install <path-or-spec>
```

Säkerhetsanmärkning: behandla plugin installationer som kör kod. Föredrar fästa versioner.

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
