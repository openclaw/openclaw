---
summary: "Manejo de fecha y hora en envoltorios, prompts, herramientas y conectores"
read_when:
  - Estás cambiando cómo se muestran las marcas de tiempo al modelo o usuarios
  - Estás depurando el formato de tiempo en mensajes o salida del system prompt
title: "Fecha y Hora"
---

# Fecha y Hora

OpenClaw utiliza por defecto **hora local del host para marcas de tiempo de transporte** y **zona horaria del usuario solo en el system prompt**.
Las marcas de tiempo del proveedor se conservan para que las herramientas mantengan su semántica nativa (la hora actual está disponible a través de `session_status`).

## Envoltorios de mensajes (local por defecto)

Los mensajes entrantes se envuelven con una marca de tiempo (precisión de minuto):

```
[Provider ... 2026-01-05 16:26 PST] texto del mensaje
```

Esta marca de tiempo del envoltorio es **local del host por defecto**, independientemente de la zona horaria del proveedor.

Puedes anular este comportamiento:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | zona horaria IANA
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` usa UTC.
- `envelopeTimezone: "local"` usa la zona horaria del host.
- `envelopeTimezone: "user"` usa `agents.defaults.userTimezone` (recurre a zona horaria del host).
- Usa una zona horaria IANA explícita (por ejemplo, `"America/Chicago"`) para una zona fija.
- `envelopeTimestamp: "off"` elimina marcas de tiempo absolutas de los encabezados de envoltorio.
- `envelopeElapsed: "off"` elimina sufijos de tiempo transcurrido (estilo `+2m`).

### Ejemplos

**Local (predeterminado):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hola
```

**Zona horaria del usuario:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hola
```

**Tiempo transcurrido habilitado:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] seguimiento
```

## System prompt: Fecha y Hora Actual

Si se conoce la zona horaria del usuario, el system prompt incluye una
sección dedicada **Current Date & Time** con **solo la zona horaria** (sin formato de reloj/hora)
para mantener estable el caché del prompt:

```
Time zone: America/Chicago
```

Cuando el agente necesita la hora actual, usa la herramienta `session_status`; la tarjeta de estado
incluye una línea de marca de tiempo.

## Líneas de eventos del sistema (local por defecto)

Los eventos del sistema en cola insertados en el contexto del agente tienen un prefijo con una marca de tiempo usando la
misma selección de zona horaria que los envoltorios de mensajes (predeterminado: local del host).

```
System: [2026-01-12 12:19:17 PST] Modelo cambiado.
```

### Configurar zona horaria + formato del usuario

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` establece la **zona horaria local del usuario** para el contexto del prompt.
- `timeFormat` controla la **visualización 12h/24h** en el prompt. `auto` sigue las preferencias del SO.

## Detección de formato de hora (auto)

Cuando `timeFormat: "auto"`, OpenClaw inspecciona la preferencia del SO (macOS/Windows)
y recurre al formato de configuración regional. El valor detectado se **almacena en caché por proceso**
para evitar llamadas repetidas al sistema.

## Payloads de herramientas + conectores (tiempo del proveedor sin procesar + campos normalizados)

Las herramientas de canal devuelven **marcas de tiempo nativas del proveedor** y añaden campos normalizados para consistencia:

- `timestampMs`: milisegundos epoch (UTC)
- `timestampUtc`: cadena ISO 8601 UTC

Los campos sin procesar del proveedor se conservan para que no se pierda nada.

- Slack: cadenas tipo epoch de la API
- Discord: marcas de tiempo ISO UTC
- Telegram/WhatsApp: marcas de tiempo numéricas/ISO específicas del proveedor

Si necesitas hora local, conviértela posteriormente usando la zona horaria conocida.

## Documentación relacionada

- [System Prompt](/es-ES/concepts/system-prompt)
- [Zonas horarias](/es-ES/concepts/timezone)
- [Mensajes](/es-ES/concepts/messages)
