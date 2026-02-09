---
summary: "Referencja CLI dla `openclaw memory` (status/indeksowanie/wyszukiwanie)"
read_when:
  - Chcesz indeksować lub przeszukiwać pamięć semantyczną
  - Debugujesz dostępność pamięci lub proces indeksowania
title: "pamięć"
---

# `openclaw memory`

Zarządzaj indeksowaniem i wyszukiwaniem pamięci semantycznej.
Dostarczane przez aktywną wtyczkę pamięci (domyślnie: `memory-core`; ustaw `plugins.slots.memory = "none"`, aby wyłączyć).

Powiązane:

- Koncepcja pamięci: [Memory](/concepts/memory)
- Wtyczki: [Plugins](/tools/plugin)

## Przykłady

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

## Opcje

Wspólne:

- `--agent <id>`: zakres ograniczony do pojedynczego agenta (domyślnie: wszyscy skonfigurowani agenci).
- `--verbose`: emituje szczegółowe logi podczas sondowania i indeksowania.

Uwagi:

- `memory status --deep` sonduje dostępność wektorów i embeddingów.
- `memory status --deep --index` uruchamia ponowne indeksowanie, jeśli magazyn jest „brudny”.
- `memory index --verbose` wypisuje szczegóły dla poszczególnych faz (dostawca, model, źródła, aktywność wsadów).
- `memory status` uwzględnia wszelkie dodatkowe ścieżki skonfigurowane przez `memorySearch.extraPaths`.
