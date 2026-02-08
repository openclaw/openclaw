---
summary: "Référence CLI pour `openclaw logs` (suivre en continu les journaux de la Gateway via RPC)"
read_when:
  - Vous devez suivre à distance les journaux de la Gateway (passerelle) (sans SSH)
  - Vous voulez des lignes de journaux JSON pour l’outillage
title: "journaux"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:00:56Z
---

# `openclaw logs`

Suivre en continu les journaux de fichiers de la Gateway (passerelle) via RPC (fonctionne en mode distant).

Lié :

- Vue d’ensemble de la journalisation : [Journalisation](/logging)

## Exemples

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
