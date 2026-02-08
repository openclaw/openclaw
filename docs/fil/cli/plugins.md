---
summary: "Sanggunian ng CLI para sa `openclaw plugins` (listahan, install, enable/disable, doctor)"
read_when:
  - Gusto mong mag-install o mag-manage ng mga in-process na plugin ng Gateway
  - Gusto mong mag-debug ng mga failure sa pag-load ng plugin
title: "mga plugin"
x-i18n:
  source_path: cli/plugins.md
  source_hash: 60476e0a9b7247bd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:19Z
---

# `openclaw plugins`

I-manage ang mga plugin/extension ng Gateway (nilo-load in-process).

Kaugnay:

- Plugin system: [Mga Plugin](/tools/plugin)
- Manifest + schema ng plugin: [Manifest ng plugin](/plugins/manifest)
- Pagpapatibay ng seguridad: [Security](/gateway/security)

## Mga command

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Ang mga bundled na plugin ay kasama sa OpenClaw ngunit nagsisimulang naka-disable. Gamitin ang `plugins enable` para
i-activate ang mga ito.

Lahat ng plugin ay kailangang may `openclaw.plugin.json` file na may inline na JSON Schema
(`configSchema`, kahit walang laman). Ang nawawala o invalid na mga manifest o schema ay pumipigil
sa pag-load ng plugin at nagdudulot ng failure sa config validation.

### I-install

```bash
openclaw plugins install <path-or-spec>
```

Tala sa seguridad: ituring ang pag-install ng plugin na parang pagpapatakbo ng code. Mas mainam ang mga pinned na bersyon.

Mga suportadong archive: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Gamitin ang `--link` para iwasan ang pagkopya ng lokal na directory (idinadagdag sa `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

### I-update

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Ang mga update ay nalalapat lamang sa mga plugin na naka-install mula sa npm (sinusubaybayan sa `plugins.installs`).
