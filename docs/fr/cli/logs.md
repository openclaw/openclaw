---
summary: "Référence CLI pour `openclaw logs` (suivre en continu les journaux de la Gateway via RPC)"
read_when:
  - Vous devez suivre à distance les journaux de la Gateway (passerelle) (sans SSH)
  - Vous voulez des lignes de journaux JSON pour l’outillage
title: "journaux"
---

# `openclaw logs`

Suivre en continu les journaux de fichiers de la Gateway (passerelle) via RPC (fonctionne en mode distant).

Liens connexes :

- Vue d’ensemble de la journalisation : [Journalisation](/logging)

## Exemples

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
