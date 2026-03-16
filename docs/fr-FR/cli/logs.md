---
summary: "Référence CLI pour `openclaw logs` (suivre les logs de la passerelle via RPC)"
read_when:
  - Vous devez suivre les logs de la Passerelle à distance (sans SSH)
  - Vous souhaitez des lignes de log JSON pour vos outils
title: "logs"
---

# `openclaw logs`

Suivre les logs de fichiers de la Passerelle via RPC (fonctionne en mode distant).

Voir aussi :

- Vue d'ensemble du logging : [Logging](/fr-FR/gateway/logging)

## Exemples

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
```

Utilisez `--local-time` pour afficher les horodatages dans votre fuseau horaire local.
