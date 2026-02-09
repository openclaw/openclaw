---
summary: "CLI-Referenz für `openclaw memory` (Status/Index/Suche)"
read_when:
  - Sie möchten semantischen Speicher indizieren oder durchsuchen
  - Sie debuggen die Speicherverfügbarkeit oder Indizierung
title: "memory"
---

# `openclaw memory`

Verwalten Sie die Indizierung und Suche des semantischen Speichers.
Bereitgestellt durch das aktive Memory-Plugin (Standard: `memory-core`; setzen Sie `plugins.slots.memory = "none"`, um es zu deaktivieren).

Verwandt:

- Memory-Konzept: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Beispiele

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

## Optionen

Allgemein:

- `--agent <id>`: auf einen einzelnen Agenten beschränken (Standard: alle konfigurierten Agenten).
- `--verbose`: detaillierte Logs während Prüfungen und der Indizierung ausgeben.

Hinweise:

- `memory status --deep` prüft die Verfügbarkeit von Vektoren und Embeddings.
- `memory status --deep --index` führt eine Neuindizierung aus, wenn der Store „dirty“ ist.
- `memory index --verbose` gibt Details pro Phase aus (Anbieter, Modell, Quellen, Batch-Aktivität).
- `memory status` schließt alle zusätzlichen Pfade ein, die über `memorySearch.extraPaths` konfiguriert sind.
