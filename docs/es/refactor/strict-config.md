---
summary: "Validación estricta de configuración + migraciones solo con doctor"
read_when:
  - Diseñar o implementar el comportamiento de validación de configuración
  - Trabajar en migraciones de configuración o flujos de trabajo de doctor
  - Manejar esquemas de configuración de plugins o el bloqueo de carga de plugins
title: "Validación estricta de configuración"
---

# Validación estricta de configuración (migraciones solo con doctor)

## Objetivos

- **Rechazar claves de configuración desconocidas en todas partes** (raíz + anidadas).
- **Rechazar la configuración de plugins sin un esquema**; no cargar ese plugin.
- **Eliminar la auto‑migración heredada al cargar**; las migraciones se ejecutan solo mediante doctor.
- **Ejecutar doctor automáticamente (dry-run) al iniciar**; si es inválido, bloquear los comandos no diagnósticos.

## No objetivos

- Compatibilidad hacia atrás al cargar (las claves heredadas no se auto‑migran).
- Eliminaciones silenciosas de claves no reconocidas.

## Reglas de validación estricta

- La configuración debe coincidir exactamente con el esquema en todos los niveles.
- Las claves desconocidas son errores de validación (sin passthrough en la raíz ni en niveles anidados).
- `plugins.entries.<id>.config` debe validarse mediante el esquema del plugin.
  - Si un plugin carece de un esquema, **rechazar la carga del plugin** y mostrar un error claro.
- Las claves `channels.<id>` desconocidas son errores a menos que un manifiesto de plugin declare el id del canal.
- Los manifiestos de plugins (`openclaw.plugin.json`) son obligatorios para todos los plugins.

## Aplicación de esquemas de plugins

- Cada plugin proporciona un JSON Schema estricto para su configuración (en línea en el manifiesto).
- Flujo de carga del plugin:
  1. Resolver el manifiesto del plugin + el esquema (`openclaw.plugin.json`).
  2. Validar la configuración contra el esquema.
  3. Si falta el esquema o la configuración es inválida: bloquear la carga del plugin y registrar el error.
- El mensaje de error incluye:
  - Id del plugin
  - Motivo (falta de esquema / configuración inválida)
  - Ruta(s) que fallaron la validación
- Los plugins deshabilitados conservan su configuración, pero Doctor + los logs muestran una advertencia.

## Flujo de Doctor

- Doctor se ejecuta **cada vez** que se carga la configuración (dry-run por defecto).
- Si la configuración es inválida:
  - Imprimir un resumen + errores accionables.
  - Instruir: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - Aplica migraciones.
  - Elimina claves desconocidas.
  - Escribe la configuración actualizada.

## Bloqueo de comandos (cuando la configuración es inválida)

Permitidos (solo diagnósticos):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Todo lo demás debe fallar de forma contundente con: “Configuración inválida. Ejecute `openclaw doctor --fix`.”

## Formato de UX de errores

- Un único encabezado de resumen.
- Secciones agrupadas:
  - Claves desconocidas (rutas completas)
  - Claves heredadas / migraciones necesarias
  - Fallos de carga de plugins (id del plugin + motivo + ruta)

## Puntos de implementación

- `src/config/zod-schema.ts`: eliminar el passthrough de la raíz; objetos estrictos en todas partes.
- `src/config/zod-schema.providers.ts`: asegurar esquemas de canal estrictos.
- `src/config/validation.ts`: fallar ante claves desconocidas; no aplicar migraciones heredadas.
- `src/config/io.ts`: eliminar auto‑migraciones heredadas; ejecutar siempre doctor en dry-run.
- `src/config/legacy*.ts`: mover el uso solo a doctor.
- `src/plugins/*`: agregar registro de esquemas + bloqueo.
- Bloqueo de comandos de la CLI en `src/cli`.

## Pruebas

- Rechazo de claves desconocidas (raíz + anidadas).
- Plugin sin esquema → carga del plugin bloqueada con error claro.
- Configuración inválida → inicio del Gateway bloqueado excepto comandos de diagnóstico.
- Doctor en dry-run automático; `doctor --fix` escribe la configuración corregida.
