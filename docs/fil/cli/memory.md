---
summary: "Reference ng CLI para sa `openclaw memory` (status/index/search)"
read_when:
  - Gusto mong mag-index o maghanap sa semantic memory
  - Nagde-debug ka ng availability o pag-index ng memory
title: "memory"
---

# `openclaw memory`

Pamahalaan ang semantic memory indexing at search.
Ibinibigay ng aktibong memory plugin (default: `memory-core`; itakda ang `plugins.slots.memory = "none"` upang i-disable).

Kaugnay:

- Konsepto ng Memory: [Memory](/concepts/memory)
- Mga plugin: [Plugins](/tools/plugin)

## Mga halimbawa

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

## Mga opsyon

Karaniwan:

- `--agent <id>`: i-scope sa isang agent lang (default: lahat ng naka-configure na agent).
- `--verbose`: maglabas ng detalyadong logs habang nagpo-probe at nag-i-index.

Mga tala:

- `memory status --deep` sinusuri ang availability ng vector at embedding.
- `memory status --deep --index` nagpapatakbo ng reindex kung marumi ang store.
- `memory index --verbose` nagpi-print ng mga detalye kada phase (provider, model, sources, batch activity).
- `memory status` isinasama ang anumang dagdag na path na naka-configure sa pamamagitan ng `memorySearch.extraPaths`.
