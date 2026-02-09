---
summary: "Aplicar parches de múltiples archivos con la herramienta apply_patch"
read_when:
  - Necesita ediciones estructuradas de archivos en múltiples archivos
  - Desea documentar o depurar ediciones basadas en parches
title: "Herramienta apply_patch"
---

# herramienta apply_patch

Aplique cambios a archivos usando un formato de parche estructurado. Esto es ideal para ediciones de múltiples archivos
o de múltiples _hunks_, donde una sola llamada `edit` sería frágil.

La herramienta acepta una sola cadena `input` que envuelve una o más operaciones de archivo:

```
*** Begin Patch
*** Add File: path/to/file.txt
+line 1
+line 2
*** Update File: src/app.ts
@@
-old line
+new line
*** Delete File: obsolete.txt
*** End Patch
```

## Parámetros

- `input` (obligatorio): Contenido completo del parche, incluyendo `*** Begin Patch` y `*** End Patch`.

## Notas

- Las rutas se resuelven de forma relativa a la raíz del espacio de trabajo.
- Use `*** Move to:` dentro de un _hunk_ `*** Update File:` para renombrar archivos.
- `*** End of File` marca una inserción solo al final del archivo (EOF) cuando es necesario.
- Experimental y deshabilitado de forma predeterminada. Habilítelo con `tools.exec.applyPatch.enabled`.
- Solo para OpenAI (incluido OpenAI Codex). Opcionalmente restrinja por modelo mediante
  `tools.exec.applyPatch.allowModels`.
- La configuración está únicamente bajo `tools.exec`.

## Ejemplo

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
