---
summary: "Validación estricta de configuración + migraciones solo vía doctor"
read_when:
  - Diseñando o implementando comportamiento de validación de configuración
  - Trabajando en migraciones de configuración o flujos de trabajo de doctor
  - Manejando esquemas de configuración de plugins o puertas de carga de plugins
title: "Validación Estricta de Configuración"
---

# Validación estricta de configuración (migraciones solo vía doctor)

## Objetivos

- **Rechazar claves de config desconocidas en todas partes** (raíz + anidadas), excepto metadata `$schema` de raíz.
- **Rechazar configuración de plugin sin esquema**; no cargar ese plugin.
- **Eliminar auto-migración heredada en carga**; migraciones se ejecutan solo vía doctor.
- **Auto-ejecutar doctor (dry-run) al iniciar**; si es inválido, bloquear comandos no-diagnósticos.

## No-objetivos

- Compatibilidad hacia atrás en carga (claves heredadas no se auto-migran).
- Eliminación silenciosa de claves no reconocidas.

## Reglas de validación estricta

- La configuración debe coincidir exactamente con el esquema en cada nivel.
- Las claves desconocidas son errores de validación (sin passthrough en raíz o anidado), excepto `$schema` de raíz cuando es un string.
- `plugins.entries.<id>.config` debe ser validado por el esquema del plugin.
  - Si un plugin carece de esquema, **rechazar carga de plugin** y mostrar un error claro.
- Las claves desconocidas de `channels.<id>` son errores a menos que un manifiesto de plugin declare el id de canal.
- Los manifiestos de plugin (`openclaw.plugin.json`) son requeridos para todos los plugins.

## Aplicación de esquema de plugin

- Cada plugin proporciona un JSON Schema estricto para su configuración (inline en el manifiesto).
- Flujo de carga de plugin:
  1. Resolver manifiesto + esquema de plugin (`openclaw.plugin.json`).
  2. Validar configuración contra el esquema.
  3. Si falta esquema o configuración inválida: bloquear carga de plugin, registrar error.
- El mensaje de error incluye:
  - Id de plugin
  - Razón (esquema faltante / configuración inválida)
  - Ruta(s) que fallaron validación
- Los plugins deshabilitados mantienen su configuración, pero Doctor + registros muestran una advertencia.

## Flujo de Doctor

- Doctor se ejecuta **cada vez** que se carga la configuración (dry-run por defecto).
- Si la configuración es inválida:
  - Imprimir un resumen + errores accionables.
  - Instruir: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - Aplica migraciones.
  - Elimina claves desconocidas.
  - Escribe configuración actualizada.

## Puerta de comandos (cuando la configuración es inválida)

Permitidos (solo diagnóstico):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Todo lo demás debe fallar con: "Config invalid. Run `openclaw doctor --fix`."

## Formato UX de errores

- Encabezado de resumen único.
- Secciones agrupadas:
  - Claves desconocidas (rutas completas)
  - Claves heredadas / migraciones necesarias
  - Fallos de carga de plugin (id de plugin + razón + ruta)

## Puntos de contacto de implementación

- `src/config/zod-schema.ts`: eliminar passthrough de raíz; objetos estrictos en todas partes.
- `src/config/zod-schema.providers.ts`: asegurar esquemas de canal estrictos.
- `src/config/validation.ts`: fallar en claves desconocidas; no aplicar migraciones heredadas.
- `src/config/io.ts`: eliminar auto-migraciones heredadas; ejecutar siempre doctor dry-run.
- `src/config/legacy*.ts`: mover uso solo a doctor.
- `src/plugins/*`: agregar registro de esquema + puerta.
- Puerta de comandos CLI en `src/cli`.

## Pruebas

- Rechazo de clave desconocida (raíz + anidado).
- Plugin sin esquema → carga de plugin bloqueada con error claro.
- Configuración inválida → inicio de gateway bloqueado excepto comandos diagnósticos.
- Doctor dry-run auto; `doctor --fix` escribe configuración corregida.
