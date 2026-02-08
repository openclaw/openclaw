---
summary: "Référence CLI pour `openclaw pairing` (approuver/lister les demandes d’appariement)"
read_when:
  - Vous utilisez des Messages prives en mode appariement et devez approuver des expéditeurs
title: "appariement"
x-i18n:
  source_path: cli/pairing.md
  source_hash: e0bc9707294463c9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:00:57Z
---

# `openclaw pairing`

Approuver ou inspecter les demandes d’appariement en Message prive (pour les canaux qui prennent en charge l’appariement).

Connexe :

- Flux d’appariement : [Appariement](/start/pairing)

## Commandes

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code> --notify
```
