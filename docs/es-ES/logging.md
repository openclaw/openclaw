---
summary: "Resumen de registro de eventos: registros de archivos, salida de consola, seguimiento CLI y la Interfaz de Control"
read_when:
  - Necesitas una descripción general amigable del registro de eventos
  - Deseas configurar niveles o formatos de registro
  - Estás solucionando problemas y necesitas encontrar registros rápidamente
title: "Registro de eventos"
---

# Registro de eventos

OpenClaw registra en dos lugares:

- **Registros de archivos** (líneas JSON) escritos por el Gateway.
- **Salida de consola** mostrada en terminales y la Interfaz de Control.

Esta página explica dónde están los registros, cómo leerlos y cómo configurar los
niveles y formatos de registro.

## Dónde están los registros

Por defecto, el Gateway escribe un archivo de registro rotativo en:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

La fecha usa la zona horaria local del host del gateway.

Puedes anular esto en `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## Cómo leer registros

### CLI: seguimiento en vivo (recomendado)

Usa el CLI para seguir el archivo de registro del gateway mediante RPC:

```bash
openclaw logs --follow
```

Modos de salida:

- **Sesiones TTY**: líneas de registro bonitas, coloreadas y estructuradas.
- **Sesiones no TTY**: texto plano.
- `--json`: JSON delimitado por líneas (un evento de registro por línea).
- `--plain`: forzar texto plano en sesiones TTY.
- `--no-color`: deshabilitar colores ANSI.

En modo JSON, el CLI emite objetos con etiqueta `type`:

- `meta`: metadatos del flujo (archivo, cursor, tamaño)
- `log`: entrada de registro analizada
- `notice`: pistas de truncamiento / rotación
- `raw`: línea de registro sin analizar

Si el Gateway no es accesible, el CLI imprime una sugerencia corta para ejecutar:

```bash
openclaw doctor
```

### Interfaz de Control (web)

La pestaña **Logs** de la Interfaz de Control sigue el mismo archivo usando `logs.tail`.
Consulta [/es-ES/web/control-ui](/es-ES/web/control-ui) para saber cómo abrirla.

### Registros solo de canal

Para filtrar actividad de canal (WhatsApp/Telegram/etc), usa:

```bash
openclaw channels logs --channel whatsapp
```

## Formatos de registro

### Registros de archivos (JSONL)

Cada línea en el archivo de registro es un objeto JSON. El CLI y la Interfaz de Control analizan estas
entradas para renderizar salida estructurada (tiempo, nivel, subsistema, mensaje).

### Salida de consola

Los registros de consola son **conscientes de TTY** y formateados para legibilidad:

- Prefijos de subsistema (por ejemplo, `gateway/channels/whatsapp`)
- Coloración de nivel (info/warn/error)
- Modo compacto o JSON opcional

El formato de consola se controla mediante `logging.consoleStyle`.

## Configurar el registro

Toda la configuración de registro está bajo `logging` en `~/.openclaw/openclaw.json`.

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### Niveles de registro

- `logging.level`: nivel de **registros de archivos** (JSONL).
- `logging.consoleLevel`: nivel de verbosidad de **consola**.

`--verbose` solo afecta la salida de consola; no cambia los niveles de registro de archivos.

### Estilos de consola

`logging.consoleStyle`:

- `pretty`: amigable para humanos, coloreado, con marcas de tiempo.
- `compact`: salida más ajustada (mejor para sesiones largas).
- `json`: JSON por línea (para procesadores de registros).

### Redacción

Los resúmenes de herramientas pueden redactar tokens sensibles antes de que lleguen a la consola:

- `logging.redactSensitive`: `off` | `tools` (predeterminado: `tools`)
- `logging.redactPatterns`: lista de cadenas regex para anular el conjunto predeterminado

La redacción afecta **solo la salida de consola** y no altera los registros de archivos.

## Diagnósticos + OpenTelemetry

Los diagnósticos son eventos estructurados y legibles por máquina para ejecuciones de modelo **y**
telemetría de flujo de mensajes (webhooks, encolado, estado de sesión). **No**
reemplazan los registros; existen para alimentar métricas, trazas y otros exportadores.

Los eventos de diagnóstico se emiten en proceso, pero los exportadores solo se adjuntan cuando
los diagnósticos + el plugin exportador están habilitados.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**: el modelo de datos + SDKs para trazas, métricas y registros.
- **OTLP**: el protocolo de cable usado para exportar datos OTel a un recolector/backend.
- OpenClaw exporta mediante **OTLP/HTTP (protobuf)** actualmente.

### Señales exportadas

- **Métricas**: contadores + histogramas (uso de tokens, flujo de mensajes, encolado).
- **Trazas**: spans para uso de modelo + procesamiento de webhook/mensaje.
- **Registros**: exportados sobre OTLP cuando `diagnostics.otel.logs` está habilitado. El
  volumen de registros puede ser alto; ten en cuenta `logging.level` y los filtros del exportador.

### Catálogo de eventos de diagnóstico

Uso del modelo:

- `model.usage`: tokens, costo, duración, contexto, proveedor/modelo/canal, ids de sesión.

Flujo de mensajes:

- `webhook.received`: ingreso de webhook por canal.
- `webhook.processed`: webhook manejado + duración.
- `webhook.error`: errores del manejador de webhook.
- `message.queued`: mensaje encolado para procesamiento.
- `message.processed`: resultado + duración + error opcional.

Cola + sesión:

- `queue.lane.enqueue`: encolado de carril de cola de comandos + profundidad.
- `queue.lane.dequeue`: desencolado de carril de cola de comandos + tiempo de espera.
- `session.state`: transición de estado de sesión + razón.
- `session.stuck`: advertencia de sesión atascada + antigüedad.
- `run.attempt`: metadatos de reintento/intento de ejecución.
- `diagnostic.heartbeat`: contadores agregados (webhooks/cola/sesión).

### Habilitar diagnósticos (sin exportador)

Usa esto si quieres eventos de diagnóstico disponibles para plugins o sumideros personalizados:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Flags de diagnóstico (registros dirigidos)

Usa flags para activar registros de depuración adicionales y dirigidos sin aumentar `logging.level`.
Los flags no distinguen mayúsculas y minúsculas y admiten comodines (por ejemplo, `telegram.*` o `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Anulación de entorno (una vez):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Notas:

- Los registros de flag van al archivo de registro estándar (igual que `logging.file`).
- La salida aún se redacta según `logging.redactSensitive`.
- Guía completa: [/es-ES/diagnostics/flags](/es-ES/diagnostics/flags).

### Exportar a OpenTelemetry

Los diagnósticos se pueden exportar mediante el plugin `diagnostics-otel` (OTLP/HTTP). Esto
funciona con cualquier recolector/backend de OpenTelemetry que acepte OTLP/HTTP.

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

Notas:

- También puedes habilitar el plugin con `openclaw plugins enable diagnostics-otel`.
- `protocol` actualmente solo admite `http/protobuf`. `grpc` se ignora.
- Las métricas incluyen uso de tokens, costo, tamaño de contexto, duración de ejecución y
  contadores/histogramas de flujo de mensajes (webhooks, encolado, estado de sesión, profundidad/espera de cola).
- Las trazas/métricas se pueden alternar con `traces` / `metrics` (predeterminado: activado). Las trazas
  incluyen spans de uso de modelo más spans de procesamiento de webhook/mensaje cuando están habilitados.
- Establece `headers` cuando tu recolector requiera autenticación.
- Variables de entorno admitidas: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Métricas exportadas (nombres + tipos)

Uso del modelo:

- `openclaw.tokens` (contador, atrs: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (contador, atrs: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (histograma, atrs: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histograma, atrs: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Flujo de mensajes:

- `openclaw.webhook.received` (contador, atrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (contador, atrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histograma, atrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (contador, atrs: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (contador, atrs: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (histograma, atrs: `openclaw.channel`,
  `openclaw.outcome`)

Colas + sesiones:

- `openclaw.queue.lane.enqueue` (contador, atrs: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (contador, atrs: `openclaw.lane`)
- `openclaw.queue.depth` (histograma, atrs: `openclaw.lane` o
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histograma, atrs: `openclaw.lane`)
- `openclaw.session.state` (contador, atrs: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (contador, atrs: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histograma, atrs: `openclaw.state`)
- `openclaw.run.attempt` (contador, atrs: `openclaw.attempt`)

### Spans exportados (nombres + atributos clave)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,
    `openclaw.sessionKey`, `openclaw.sessionId`

### Muestreo + descarga

- Muestreo de trazas: `diagnostics.otel.sampleRate` (0.0–1.0, solo spans raíz).
- Intervalo de exportación de métricas: `diagnostics.otel.flushIntervalMs` (mín 1000ms).

### Notas de protocolo

- Los endpoints OTLP/HTTP se pueden establecer mediante `diagnostics.otel.endpoint` o
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Si el endpoint ya contiene `/v1/traces` o `/v1/metrics`, se usa tal cual.
- Si el endpoint ya contiene `/v1/logs`, se usa tal cual para registros.
- `diagnostics.otel.logs` habilita la exportación de registros OTLP para la salida del registrador principal.

### Comportamiento de exportación de registros

- Los registros OTLP usan los mismos registros estructurados escritos en `logging.file`.
- Respetan `logging.level` (nivel de registro de archivos). La redacción de consola **no** se aplica
  a los registros OTLP.
- Las instalaciones de alto volumen deben preferir muestreo/filtrado del recolector OTLP.

## Consejos de solución de problemas

- **¿Gateway no accesible?** Ejecuta `openclaw doctor` primero.
- **¿Registros vacíos?** Verifica que el Gateway esté ejecutándose y escribiendo en la ruta de archivo
  en `logging.file`.
- **¿Necesitas más detalle?** Establece `logging.level` a `debug` o `trace` y reintenta.
