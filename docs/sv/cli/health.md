---
summary: "CLI-referens för `openclaw health` (Gateway-hälsoendpoint via RPC)"
read_when:
  - Du vill snabbt kontrollera den körande Gatewayns hälsa
title: "hälsa"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:42Z
---

# `openclaw health`

Hämta hälsostatus från den körande Gateway.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Noteringar:

- `--verbose` kör live-prober och skriver ut tidsmätningar per konto när flera konton är konfigurerade.
- Utdata inkluderar sessionslager per agent när flera agenter är konfigurerade.
