---
summary: "Reference CLI pour `openclaw health` (point de terminaison de sante de la Gateway (passerelle) via RPC)"
read_when:
  - Vous souhaitez verifier rapidement l'etat de sante de la Gateway (passerelle) en cours d'execution
title: "sante"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:00:54Z
---

# `openclaw health`

Recupere l'etat de sante de la Gateway (passerelle) en cours d'execution.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Notes :

- `--verbose` execute des sondes en temps reel et affiche des temps par compte lorsque plusieurs comptes sont configures.
- La sortie inclut des magasins de sessions par agent lorsque plusieurs agents sont configures.
