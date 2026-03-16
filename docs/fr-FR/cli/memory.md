---
summary: "Référence CLI pour `openclaw memory` (status/index/search)"
read_when:
  - Vous voulez indexer ou rechercher la mémoire sémantique
  - Vous déboguez la disponibilité ou l'indexation de la mémoire
title: "memory"
---

# `openclaw memory`

Gérer l'indexation et la recherche de mémoire sémantique.
Fourni par le plugin de mémoire actif (par défaut : `memory-core` ; définissez `plugins.slots.memory = "none"` pour désactiver).

Connexe :

- Concept de mémoire : [Mémoire](/fr-FR/concepts/memory)
- Plugins : [Plugins](/fr-FR/tools/plugin)

## Exemples

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "liste de vérification de version"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## Options

Courantes :

- `--agent <id>` : limiter à un seul agent (par défaut : tous les agents configurés).
- `--verbose` : émettre des logs détaillés pendant les sondes et l'indexation.

Notes :

- `memory status --deep` sonde la disponibilité du vecteur + embedding.
- `memory status --deep --index` exécute une réindexation si le magasin est sale.
- `memory index --verbose` affiche les détails par phase (fournisseur, modèle, sources, activité par lots).
- `memory status` inclut tous les chemins supplémentaires configurés via `memorySearch.extraPaths`.
