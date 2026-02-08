---
summary: "CLI-referens för `openclaw pairing` (godkänn/lista parningsförfrågningar)"
read_when:
  - Du använder DM:er i parningsläge och behöver godkänna avsändare
title: "parning"
x-i18n:
  source_path: cli/pairing.md
  source_hash: 785869d24d953141
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:43Z
---

# `openclaw pairing`

Godkänn eller inspektera DM-parningsförfrågningar (för kanaler som stöder parning).

Relaterat:

- Parningsflöde: [Parning](/channels/pairing)

## Kommandon

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code> --notify
```
