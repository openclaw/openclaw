---
summary: "Superficies de registro, archivos de logs, estilos de logs WS y formato de consola"
read_when:
  - Cambiar la salida o los formatos de logging
  - Depurar la salida de la CLI o del Gateway
title: "Logging"
---

# Logging

Para una vista general orientada al usuario (CLI + Control UI + configuración), consulte [/logging](/logging).

OpenClaw tiene dos “superficies” de logs:

- **Salida de consola** (lo que usted ve en el terminal / UI de depuración).
- **Logs en archivos** (líneas JSON) escritos por el logger del Gateway.

## Logger basado en archivos

- El archivo de log rotativo predeterminado está en `/tmp/openclaw/` (un archivo por día): `openclaw-YYYY-MM-DD.log`
  - La fecha usa la zona horaria local del host del Gateway.
- La ruta del archivo de log y el nivel se pueden configurar mediante `~/.openclaw/openclaw.json`:
  - `logging.file`
  - `logging.level`

El formato del archivo es un objeto JSON por línea.

La pestaña Logs del Control UI sigue este archivo a través del Gateway (`logs.tail`).
La CLI puede hacer lo mismo:

```bash
openclaw logs --follow
```

**Verbose vs. niveles de log**

- Los **logs en archivos** se controlan exclusivamente por `logging.level`.
- `--verbose` solo afecta la **verbosidad de la consola** (y el estilo de logs WS); **no**
  eleva el nivel de log del archivo.
- Para capturar detalles solo-verbose en los logs de archivo, configure `logging.level` en `debug` o
  `trace`.

## Captura de consola

La CLI captura `console.log/info/warn/error/debug/trace` y los escribe en los logs de archivo,
mientras sigue imprimiendo en stdout/stderr.

Usted puede ajustar la verbosidad de la consola de forma independiente mediante:

- `logging.consoleLevel` (predeterminado `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Redacción de resúmenes de herramientas

Los resúmenes verbosos de herramientas (p. ej., `🛠️ Exec: ...`) pueden enmascarar tokens sensibles antes de que lleguen
al flujo de la consola. Esto es **solo para herramientas** y no altera los logs de archivo.

- `logging.redactSensitive`: `off` | `tools` (predeterminado: `tools`)
- `logging.redactPatterns`: arreglo de cadenas regex (anula los valores predeterminados)
  - Use cadenas regex sin procesar (auto `gi`), o `/pattern/flags` si necesita banderas personalizadas.
  - Las coincidencias se enmascaran conservando los primeros 6 + los últimos 4 caracteres (longitud >= 18); de lo contrario `***`.
  - Los valores predeterminados cubren asignaciones comunes de claves, flags de la CLI, campos JSON, encabezados bearer, bloques PEM y prefijos populares de tokens.

## Logs de WebSocket del Gateway

El Gateway imprime logs del protocolo WebSocket en dos modos:

- **Modo normal (sin `--verbose`)**: solo se imprimen resultados RPC “interesantes”:
  - errores (`ok=false`)
  - llamadas lentas (umbral predeterminado: `>= 50ms`)
  - errores de parseo
- **Modo verbose (`--verbose`)**: imprime todo el tráfico de solicitudes/respuestas WS.

### Estilo de logs WS

`openclaw gateway` admite un cambio de estilo por Gateway:

- `--ws-log auto` (predeterminado): el modo normal está optimizado; el modo verbose usa salida compacta
- `--ws-log compact`: salida compacta (solicitud/respuesta emparejadas) cuando está en verbose
- `--ws-log full`: salida completa por frame cuando está en verbose
- `--compact`: alias de `--ws-log compact`

Ejemplos:

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## Formato de consola (logging por subsistemas)

El formateador de consola es **consciente de TTY** y muestra líneas consistentes con prefijos.
Los loggers por subsistema mantienen la salida agrupada y fácil de escanear.

Comportamiento:

- **Prefijos de subsistema** en cada línea (p. ej., `[gateway]`, `[canvas]`, `[tailscale]`)
- **Colores por subsistema** (estables por subsistema) además del color por nivel
- **Color cuando la salida es un TTY o el entorno parece un terminal enriquecido** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), respeta `NO_COLOR`
- **Prefijos de subsistema abreviados**: elimina el `gateway/` inicial + `channels/`, conserva los últimos 2 segmentos (p. ej., `whatsapp/outbound`)
- **Sub-loggers por subsistema** (prefijo automático + campo estructurado `{ subsystem }`)
- **`logRaw()`** para salida QR/UX (sin prefijo, sin formato)
- **Estilos de consola** (p. ej., `pretty | compact | json`)
- **Nivel de log de consola** separado del nivel de log de archivo (el archivo mantiene todo el detalle cuando `logging.level` se establece en `debug`/`trace`)
- **Los cuerpos de mensajes de WhatsApp** se registran en `debug` (use `--verbose` para verlos)

Esto mantiene estables los logs de archivo existentes mientras hace que la salida interactiva sea fácil de escanear.
