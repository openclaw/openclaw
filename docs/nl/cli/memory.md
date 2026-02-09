---
summary: "CLI-referentie voor `openclaw memory` (status/index/search)"
read_when:
  - Je wilt semantisch geheugen indexeren of doorzoeken
  - Je bent bezig met het debuggen van geheugenbeschikbaarheid of indexering
title: "geheugen"
---

# `openclaw memory`

Beheer semantische geheugenindexering en -zoekopdrachten.
Aangeboden door de actieve geheugenplugin (standaard: `memory-core`; stel `plugins.slots.memory = "none"` in om uit te schakelen).

Gerelateerd:

- Geheugenconcept: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Voorbeelden

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

## Opties

Algemeen:

- `--agent <id>`: scope tot één agent (standaard: alle geconfigureerde agents).
- `--verbose`: geef gedetailleerde logs weer tijdens probes en indexering.

Notities:

- `memory status --deep` controleert de beschikbaarheid van vectoren + embeddings.
- `memory status --deep --index` voert een herindexering uit als de store dirty is.
- `memory index --verbose` toont details per fase (provider, model, bronnen, batchactiviteit).
- `memory status` neemt alle extra paden mee die zijn geconfigureerd via `memorySearch.extraPaths`.
