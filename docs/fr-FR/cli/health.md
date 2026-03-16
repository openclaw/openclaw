---
summary: "Référence CLI pour `openclaw health` (endpoint de santé de la passerelle via RPC)"
read_when:
  - Vous souhaitez vérifier rapidement la santé de la Passerelle en cours d'exécution
title: "health"
---

# `openclaw health`

Récupérer l'état de santé de la Passerelle en cours d'exécution.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Remarques :

- `--verbose` exécute des sondes en direct et affiche les temps par compte lorsque plusieurs comptes sont configurés.
- La sortie inclut les magasins de sessions par agent lorsque plusieurs agents sont configurés.
