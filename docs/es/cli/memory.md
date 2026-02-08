---
summary: "Referencia de la CLI para `openclaw memory` (status/index/search)"
read_when:
  - Quiere indexar o buscar memoria semántica
  - Está depurando la disponibilidad de la memoria o la indexación
title: "memoria"
x-i18n:
  source_path: cli/memory.md
  source_hash: cb8ee2c9b2db2d57
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:56Z
---

# `openclaw memory`

Gestione la indexación y la búsqueda de memoria semántica.
Proporcionado por el plugin de memoria activo (predeterminado: `memory-core`; establezca `plugins.slots.memory = "none"` para deshabilitar).

Relacionado:

- Concepto de memoria: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Ejemplos

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

## Opciones

Comunes:

- `--agent <id>`: limitar el alcance a un solo agente (predeterminado: todos los agentes configurados).
- `--verbose`: emitir registros detallados durante las sondas y la indexación.

Notas:

- `memory status --deep` sondea la disponibilidad de vectores + embeddings.
- `memory status --deep --index` ejecuta una reindexación si el almacén está sucio.
- `memory index --verbose` imprime detalles por fase (proveedor, modelo, fuentes, actividad por lotes).
- `memory status` incluye cualquier ruta adicional configurada mediante `memorySearch.extraPaths`.
