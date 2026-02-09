---
summary: "CLI-reference for `openclaw memory` (status/index/search)"
read_when:
  - Du vil indeksere eller søge i semantisk hukommelse
  - Du fejlretter hukommelsestilgængelighed eller indeksering
title: "hukommelse"
---

# `openclaw memory`

Administrer semantisk hukommelse indeksering og søgning.
Leveret af det aktive hukommelse plugin (standard: `memory-core`; sæt `plugins.slots.memory = "none"` til at deaktivere).

Relateret:

- Hukommelseskoncept: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Eksempler

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

## Indstillinger

Fælles:

- `--agent <id>`: afgræns til en enkelt agent (standard: alle konfigurerede agenter).
- `--verbose`: udskriv detaljerede logs under prober og indeksering.

Noter:

- `memory status --deep` sonderer tilgængelighed af vektorer og embeddings.
- `memory status --deep --index` kører en genindeksering, hvis lageret er beskidt.
- `memory index --verbose` udskriver detaljer pr. fase (udbyder, model, kilder, batchaktivitet).
- `memory status` inkluderer eventuelle ekstra stier konfigureret via `memorySearch.extraPaths`.
