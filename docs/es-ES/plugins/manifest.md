---
summary: "Manifiesto de plugin + requisitos de esquema JSON (validación estricta de configuración)"
read_when:
  - Estás construyendo un plugin de OpenClaw
  - Necesitas enviar un esquema de configuración de plugin o depurar errores de validación de plugin
title: "Manifiesto de Plugin"
---

# Manifiesto de plugin (openclaw.plugin.json)

Cada plugin **debe** incluir un archivo `openclaw.plugin.json` en la **raíz del plugin**.
OpenClaw usa este manifiesto para validar la configuración **sin ejecutar código del
plugin**. Los manifiestos faltantes o inválidos se tratan como errores de plugin y bloquean
la validación de configuración.

Consulta la guía completa del sistema de plugins: [Plugins](/es-ES/tools/plugin).

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
- `configSchema` (object): JSON Schema para la configuración del plugin (en línea).

Claves opcionales:

- `kind` (string): tipo de plugin (ejemplo: `"memory"`).
- `channels` (array): ids de canales registrados por este plugin (ejemplo: `["matrix"]`).
- `providers` (array): ids de proveedores registrados por este plugin.
- `skills` (array): directorios de habilidades para cargar (relativo a la raíz del plugin).
- `name` (string): nombre para mostrar del plugin.
- `description` (string): resumen breve del plugin.
- `uiHints` (object): etiquetas/marcadores de posición/banderas sensibles de campos de configuración para renderizado de UI.
- `version` (string): versión del plugin (informativa).

## Requisitos de JSON Schema

- **Cada plugin debe incluir un JSON Schema**, incluso si no acepta configuración.
- Un esquema vacío es aceptable (por ejemplo, `{ "type": "object", "additionalProperties": false }`).
- Los esquemas se validan en tiempo de lectura/escritura de configuración, no en tiempo de ejecución.

## Comportamiento de validación

- Las claves `channels.*` desconocidas son **errores**, a menos que el id del canal esté declarado por
  un manifiesto de plugin.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, y `plugins.slots.*`
  deben hacer referencia a ids de plugin **descubribles**. Los ids desconocidos son **errores**.
- Si un plugin está instalado pero tiene un manifiesto o esquema roto o faltante,
  la validación falla y Doctor reporta el error del plugin.
- Si existe configuración del plugin pero el plugin está **deshabilitado**, la configuración se mantiene y
  se muestra una **advertencia** en Doctor + registros.

## Notas

- El manifiesto es **requerido para todos los plugins**, incluidas las cargas desde el sistema de archivos local.
- El tiempo de ejecución todavía carga el módulo del plugin por separado; el manifiesto es solo para
  descubrimiento + validación.
- Si tu plugin depende de módulos nativos, documenta los pasos de construcción y cualquier
  requisito de lista permitida del gestor de paquetes (por ejemplo, `allow-build-scripts` de pnpm
  - `pnpm rebuild <package>`).
