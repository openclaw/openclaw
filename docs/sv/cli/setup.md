---
summary: "CLI-referens för `openclaw setup` (initiera konfig + arbetsyta)"
read_when:
  - Du gör första körningens konfigurering utan den fullständiga introduktionsguiden
  - Du vill ange standard­sökvägen för arbetsytan
title: "setup"
x-i18n:
  source_path: cli/setup.md
  source_hash: 7f3fc8b246924edf
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:51Z
---

# `openclaw setup`

Initiera `~/.openclaw/openclaw.json` och agentens arbetsyta.

Relaterat:

- Kom igång: [Getting started](/start/getting-started)
- Guide: [Onboarding](/start/onboarding)

## Exempel

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

För att köra guiden via setup:

```bash
openclaw setup --wizard
```
