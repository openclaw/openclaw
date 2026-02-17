---
title: "Aplicar Parche"
description: "Aplica archivos de parche unificados al código fuente"
---

## Descripción General

La herramienta `apply-patch` permite a los agentes aplicar parches de formato unificado (diff unificado) a archivos. Esto es útil para:

- Aplicar correcciones de código desde archivos de parche
- Integrar cambios de repositorios externos
- Implementar actualizaciones sugeridas por revisiones de código
- Automatizar actualizaciones de dependencias

## Uso Básico

```typescript
// Aplicar un archivo de parche
await applyPatch({
  patchFile: '/path/to/changes.patch',
  targetDir: '/path/to/project'
});
```

## Parámetros

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `patchFile` | string | Sí | Ruta al archivo de parche unificado |
| `targetDir` | string | No | Directorio donde aplicar el parche (por defecto: directorio actual) |
| `dryRun` | boolean | No | Si es true, muestra qué cambiaría sin aplicar realmente el parche |
| `reverse` | boolean | No | Aplica el parche en reversa |

## Ejemplo

```bash
# Crear un parche
git diff > my-changes.patch

# Aplicar el parche usando la herramienta
applyPatch({
  patchFile: 'my-changes.patch',
  targetDir: '/app/src'
});
```

## Notas

- Los parches deben estar en formato diff unificado
- La herramienta verificará que los parches se apliquen limpiamente antes de hacer cambios
- Usa `dryRun: true` para previsualizar cambios sin modificar archivos
