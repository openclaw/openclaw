---
summary: "CLI-referentie voor `openclaw pairing` (pairingverzoeken goedkeuren/lijsten)"
read_when:
  - Je gebruikt pairing-modus DM's en moet afzenders goedkeuren
title: "pairing"
x-i18n:
  source_path: cli/pairing.md
  source_hash: 785869d24d953141
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:12Z
---

# `openclaw pairing`

DM-pairingverzoeken goedkeuren of inspecteren (voor kanalen die pairing ondersteunen).

Gerelateerd:

- Pairing-flow: [Pairing](/channels/pairing)

## Opdrachten

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code> --notify
```
