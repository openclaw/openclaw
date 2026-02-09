---
summary: "Reference CLI pour `openclaw reset` (reinitialise l'etat/la configuration locaux)"
read_when:
  - Vous souhaitez effacer l'etat local tout en conservant le CLI installe
  - Vous souhaitez un dry-run de ce qui serait supprime
title: "reset"
---

# `openclaw reset`

Reinitialise la configuration et l'etat locaux (le CLI reste installe).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
