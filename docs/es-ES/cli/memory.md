---
summary: "Referencia CLI para `openclaw memory` (estado/indexación/búsqueda)"
read_when:
  - Quieres indexar o buscar en memoria semántica
  - Estás depurando disponibilidad de memoria o indexación
title: "memory"
---

# `openclaw memory`

Gestionar indexación y búsqueda de memoria semántica.
Proporcionado por el plugin de memoria activo (predeterminado: `memory-core`; establece `plugins.slots.memory = "none"` para deshabilitar).

Relacionado:

- Concepto de memoria: [Memoria](/es-ES/concepts/memory)
- Plugins: [Plugins](/es-ES/tools/plugin)

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

- `--agent <id>`: limitar a un solo agente (predeterminado: todos los agentes configurados).
- `--verbose`: emitir registros detallados durante pruebas e indexación.

Notas:

- `memory status --deep` prueba la disponibilidad de vectores + embeddings.
- `memory status --deep --index` ejecuta una reindexación si el almacén está sucio.
- `memory index --verbose` imprime detalles por fase (proveedor, modelo, fuentes, actividad por lotes).
- `memory status` incluye cualquier ruta extra configurada mediante `memorySearch.extraPaths`.
