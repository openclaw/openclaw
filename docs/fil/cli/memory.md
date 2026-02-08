---
summary: "Reference ng CLI para sa `openclaw memory` (status/index/search)"
read_when:
  - Gusto mong mag-index o maghanap sa semantic memory
  - Nagde-debug ka ng availability o pag-index ng memory
title: "memory"
x-i18n:
  source_path: cli/memory.md
  source_hash: cb8ee2c9b2db2d57
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:20Z
---

# `openclaw memory`

Pamahalaan ang pag-index at paghahanap ng semantic memory.
Ibinibigay ng aktibong memory plugin (default: `memory-core`; itakda ang `plugins.slots.memory = "none"` para i-disable).

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
