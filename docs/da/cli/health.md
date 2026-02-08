---
summary: "CLI-reference for `openclaw health` (Gateway-helbredsendepunkt via RPC)"
read_when:
  - Du vil hurtigt tjekke den kørende Gateways helbred
title: "health"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:03Z
---

# `openclaw health`

Hent helbredsstatus fra den kørende Gateway.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Noter:

- `--verbose` kører live-prober og udskriver tidsmålinger pr. konto, når flere konti er konfigureret.
- Output inkluderer sessionslagre pr. agent, når flere agenter er konfigureret.
