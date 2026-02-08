---
summary: "CLI-Referenz für `openclaw pairing` (Genehmigen/Auflisten von Pairing-Anfragen)"
read_when:
  - Sie verwenden Pairing-Modus-Direktnachrichten und müssen Absender genehmigen
title: "Pairing"
x-i18n:
  source_path: cli/pairing.md
  source_hash: 785869d24d953141
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:37Z
---

# `openclaw pairing`

Pairing-Anfragen für Direktnachrichten genehmigen oder prüfen (für Kanäle, die Pairing unterstützen).

Verwandt:

- Pairing-Ablauf: [Pairing](/channels/pairing)

## Befehle

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code> --notify
```
