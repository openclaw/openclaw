---
summary: "CLI-referens för `openclaw memory` (status/index/search)"
read_when:
  - Du vill indexera eller söka i semantiskt minne
  - Du felsöker minnestillgänglighet eller indexering
title: "minne"
x-i18n:
  source_path: cli/memory.md
  source_hash: cb8ee2c9b2db2d57
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:41Z
---

# `openclaw memory`

Hantera indexering och sökning i semantiskt minne.
Tillhandahålls av den aktiva minnespluginen (standard: `memory-core`; ange `plugins.slots.memory = "none"` för att inaktivera).

Relaterat:

- Minneskoncept: [Memory](/concepts/memory)
- Pluginer: [Plugins](/tools/plugin)

## Exempel

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

## Alternativ

Vanliga:

- `--agent <id>`: begränsa till en enskild agent (standard: alla konfigurerade agenter).
- `--verbose`: generera detaljerade loggar under sonderingar och indexering.

Noteringar:

- `memory status --deep` sonderar tillgänglighet för vektorer och inbäddningar.
- `memory status --deep --index` kör en omindexering om lagret är smutsigt.
- `memory index --verbose` skriver ut detaljer per fas (leverantör, modell, källor, batchaktivitet).
- `memory status` inkluderar eventuella extra sökvägar som konfigurerats via `memorySearch.extraPaths`.
