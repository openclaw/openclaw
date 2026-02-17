---
summary: "Superficies de registro, registros de archivos, estilos de registro WS y formato de consola"
read_when:
  - Cambiando la salida o formatos de registro
  - Depurando la salida de CLI o gateway
title: "Registro de eventos"
---

# Registro de eventos

Para una descripción general orientada al usuario (CLI + Interfaz de Control + config), consulta [/logging](/es-ES/logging).

OpenClaw tiene dos "superficies" de registro:

- **Salida de consola** (lo que ves en la terminal / Debug UI).
- **Registros de archivos** (líneas JSON) escritos por el logger del gateway.

## Logger basado en archivos

- El archivo de registro rotativo predeterminado está bajo `/tmp/openclaw/` (un archivo por día): `openclaw-YYYY-MM-DD.log`
  - La fecha usa la zona horaria local del host del gateway.
- La ruta del archivo de registro y el nivel se pueden configurar a través de `~/.openclaw/openclaw.json`:
  - `logging.file`
  - `logging.level`

El formato del archivo es un objeto JSON por línea.

La pestaña Logs de la Interfaz de Control sigue este archivo a través del gateway (`logs.tail`).
CLI puede hacer lo mismo:

```bash
openclaw logs --follow
```

**Verbose vs. niveles de registro**

- **Los registros de archivos** se controlan exclusivamente por `logging.level`.
- `--verbose` solo afecta la **verbosidad de la consola** (y el estilo de registro WS); **no**
  aumenta el nivel de registro de archivos.
- Para capturar detalles solo disponibles en modo verbose en los registros de archivos, establece `logging.level` en `debug` o
  `trace`.

## Captura de consola

La CLI captura `console.log/info/warn/error/debug/trace` y los escribe en los registros de archivos,
mientras aún los imprime en stdout/stderr.

Puedes ajustar la verbosidad de la consola independientemente a través de:

- `logging.consoleLevel` (predeterminado `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Redacción de resumen de herramientas

Los resúmenes de herramientas verbose (ej. `🛠️ Exec: ...`) pueden enmascarar tokens sensibles antes de que lleguen al
flujo de consola. Esto es **solo para herramientas** y no altera los registros de archivos.

- `logging.redactSensitive`: `off` | `tools` (predeterminado: `tools`)
- `logging.redactPatterns`: array de strings regex (anula los predeterminados)
  - Usa strings regex crudos (auto `gi`), o `/pattern/flags` si necesitas flags personalizados.
  - Las coincidencias se enmascaran manteniendo los primeros 6 + últimos 4 caracteres (longitud >= 18), de lo contrario `***`.
  - Los predeterminados cubren asignaciones de claves comunes, flags de CLI, campos JSON, encabezados bearer, bloques PEM y prefijos de tokens populares.

## Registros WebSocket del Gateway

El gateway imprime registros de protocolo WebSocket en dos modos:

- **Modo normal (sin `--verbose`)**: solo se imprimen resultados RPC "interesantes":
  - errores (`ok=false`)
  - llamadas lentas (umbral predeterminado: `>= 50ms`)
  - errores de análisis
- **Modo verbose (`--verbose`)**: imprime todo el tráfico de solicitud/respuesta WS.

### Estilo de registro WS

`openclaw gateway` admite un interruptor de estilo por gateway:

- `--ws-log auto` (predeterminado): el modo normal está optimizado; el modo verbose usa salida compacta
- `--ws-log compact`: salida compacta (solicitud/respuesta emparejada) cuando está en verbose
- `--ws-log full`: salida completa por frame cuando está en verbose
- `--compact`: alias para `--ws-log compact`

Ejemplos:

```bash
# optimizado (solo errores/lentos)
openclaw gateway

# mostrar todo el tráfico WS (emparejado)
openclaw gateway --verbose --ws-log compact

# mostrar todo el tráfico WS (metadatos completos)
openclaw gateway --verbose --ws-log full
```

## Formato de consola (registro de subsistemas)

El formateador de consola es **consciente de TTY** e imprime líneas consistentes con prefijos.
Los loggers de subsistemas mantienen la salida agrupada y escaneable.

Comportamiento:

- **Prefijos de subsistema** en cada línea (ej. `[gateway]`, `[canvas]`, `[tailscale]`)
- **Colores de subsistema** (estables por subsistema) más coloración de nivel
- **Color cuando la salida es un TTY o el entorno parece una terminal rica** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), respeta `NO_COLOR`
- **Prefijos de subsistema acortados**: elimina `gateway/` + `channels/` iniciales, mantiene los últimos 2 segmentos (ej. `whatsapp/outbound`)
- **Sub-loggers por subsistema** (prefijo automático + campo estructurado `{ subsystem }`)
- **`logRaw()`** para salida de QR/UX (sin prefijo, sin formato)
- **Estilos de consola** (ej. `pretty | compact | json`)
- **Nivel de registro de consola** separado del nivel de registro de archivos (el archivo mantiene el detalle completo cuando `logging.level` está establecido en `debug`/`trace`)
- **Cuerpos de mensajes de WhatsApp** se registran en `debug` (usa `--verbose` para verlos)

Esto mantiene los registros de archivos existentes estables mientras hace que la salida interactiva sea escaneable.
