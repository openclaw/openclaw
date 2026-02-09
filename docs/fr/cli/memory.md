---
summary: "Reference CLI pour `openclaw memory` (statut/indexation/recherche)"
read_when:
  - Vous souhaitez indexer ou rechercher la memoire semantique
  - Vous depannez la disponibilite de la memoire ou l’indexation
title: "memoire"
---

# `openclaw memory`

Gerer l’indexation et la recherche de la memoire semantique.
Fourni par le plugin de memoire actif (par defaut : `memory-core` ; definir `plugins.slots.memory = "none"` pour desactiver).

Associe :

- Concept de memoire : [Memory](/concepts/memory)
- Plugins : [Plugins](/plugins)

## Exemples

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## Options

Communes :

- `--agent <id>` : limiter a un seul agent (par defaut : tous les agents configures).
- `--verbose` : emettre des journaux detailles pendant les sondes et l’indexation.

Notes :

- `memory status --deep` sonde la disponibilite des vecteurs et des embeddings.
- `memory status --deep --index` relance une reindexation si le stockage est marque comme sale.
- `memory index --verbose` affiche les details par phase (fournisseur, modele, sources, activite par lot).
- `memory status` inclut tous les chemins supplementaires configures via `memorySearch.extraPaths`.
