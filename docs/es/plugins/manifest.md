---
summary: "Manifiesto del plugin + requisitos del esquema JSON (validación estricta de configuración)"
read_when:
  - Está construyendo un plugin de OpenClaw
  - Necesita distribuir un esquema de configuración del plugin o depurar errores de validación del plugin
title: "Manifiesto del plugin"
---

# Manifiesto del plugin (openclaw.plugin.json)

Todo plugin **debe** incluir un archivo `openclaw.plugin.json` en la **raíz del plugin**.
OpenClaw usa este manifiesto para validar la configuración **sin ejecutar el código
del plugin**. Los manifiestos faltantes o inválidos se tratan como errores del plugin y bloquean
la validación de la configuración.

Consulte la guía completa del sistema de plugins: [Plugins](/tools/plugin).

## Campos requeridos

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Claves requeridas:

- `id` (string): id canónico del plugin.
- `configSchema` (object): Esquema JSON para la configuración del plugin (en línea).

Claves opcionales:

- `kind` (string): tipo de plugin (ejemplo: `"memory"`).
- `channels` (array): ids de canal registrados por este plugin (ejemplo: `["matrix"]`).
- `providers` (array): ids de proveedor registrados por este plugin.
- `skills` (array): directorios de Skills a cargar (relativos a la raíz del plugin).
- `name` (string): nombre visible del plugin.
- `description` (string): resumen corto del plugin.
- `uiHints` (object): etiquetas de campos de configuración/marcadores de posición/indicadores de sensibilidad para la renderización de la UI.
- `version` (string): versión del plugin (informativa).

## Requisitos del esquema JSON

- **Todo plugin debe incluir un esquema JSON**, incluso si no acepta configuración.
- Se acepta un esquema vacío (por ejemplo, `{ "type": "object", "additionalProperties": false }`).
- Los esquemas se validan en el momento de lectura/escritura de la configuración, no en tiempo de ejecución.

## Comportamiento de validación

- Las claves `channels.*` desconocidas son **errores**, a menos que el id del canal esté declarado por
  un manifiesto de plugin.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny` y `plugins.slots.*`
  deben referenciar ids de plugin **descubribles**. Los ids desconocidos son **errores**.
- Si un plugin está instalado pero tiene un manifiesto o esquema roto o faltante,
  la validación falla y Doctor reporta el error del plugin.
- Si existe configuración del plugin pero el plugin está **deshabilitado**, la configuración se conserva y
  se muestra una **advertencia** en Doctor + logs.

## Notas

- El manifiesto es **obligatorio para todos los plugins**, incluidos los cargados desde el sistema de archivos local.
- El runtime aún carga el módulo del plugin por separado; el manifiesto es solo para
  descubrimiento + validación.
- Si su plugin depende de módulos nativos, documente los pasos de compilación y cualquier requisito de lista de permitidos del gestor de paquetes (por ejemplo, pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
