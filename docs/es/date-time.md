---
summary: "Manejo de fecha y hora a través de sobres, prompts, herramientas y conectores"
read_when:
  - Está cambiando cómo se muestran las marcas de tiempo al modelo o a los usuarios
  - Está depurando el formato de hora en mensajes o en la salida del prompt del sistema
title: "Fecha y Hora"
---

# Fecha y Hora

OpenClaw usa por defecto **la hora local del host para las marcas de tiempo de transporte** y **la zona horaria del usuario solo en el prompt del sistema**.
Las marcas de tiempo del proveedor se conservan para que las herramientas mantengan su semántica nativa (la hora actual está disponible vía `session_status`).

## Sobres de mensajes (local por defecto)

Los mensajes entrantes se envuelven con una marca de tiempo (precisión de minuto):

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Esta marca de tiempo del sobre es **local del host por defecto**, independientemente de la zona horaria del proveedor.

Puede sobrescribir este comportamiento:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` usa UTC.
- `envelopeTimezone: "local"` usa la zona horaria del host.
- `envelopeTimezone: "user"` usa `agents.defaults.userTimezone` (vuelve a la zona horaria del host).
- Use una zona horaria IANA explícita (p. ej., `"America/Chicago"`) para una zona fija.
- `envelopeTimestamp: "off"` elimina las marcas de tiempo absolutas de los encabezados del sobre.
- `envelopeElapsed: "off"` elimina los sufijos de tiempo transcurrido (el estilo `+2m`).

### Ejemplos

**Local (predeterminado):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**Zona horaria del usuario:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Tiempo transcurrido habilitado:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## Prompt del sistema: Fecha y Hora actuales

Si se conoce la zona horaria del usuario, el prompt del sistema incluye una sección dedicada
**Fecha y Hora actuales** con **solo la zona horaria** (sin reloj/formato de hora)
para mantener estable el caché del prompt:

```
Time zone: America/Chicago
```

Cuando el agente necesita la hora actual, use la herramienta `session_status`; la tarjeta
de estado incluye una línea de marca de tiempo.

## Líneas de eventos del sistema (local por defecto)

Los eventos del sistema en cola insertados en el contexto del agente se prefijan con una marca de tiempo usando la
misma selección de zona horaria que los sobres de mensajes (predeterminado: local del host).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Configurar zona horaria del usuario + formato

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
- `timeFormat` controla la **visualización de 12 h/24 h** en el prompt. `auto` sigue las preferencias del SO.

## Detección del formato de hora (automática)

Cuando `timeFormat: "auto"`, OpenClaw inspecciona la preferencia del SO (macOS/Windows)
y recurre al formato por configuración regional. El valor detectado se **almacena en caché por proceso**
para evitar llamadas repetidas al sistema.

## Cargas útiles de herramientas + conectores (hora cruda del proveedor + campos normalizados)

Las herramientas de canal devuelven **marcas de tiempo nativas del proveedor** y agregan campos normalizados para consistencia:

- `timestampMs`: milisegundos desde epoch (UTC)
- `timestampUtc`: cadena ISO 8601 en UTC

Los campos crudos del proveedor se conservan para que no se pierda nada.

- Slack: cadenas tipo epoch desde la API
- Discord: marcas de tiempo ISO en UTC
- Telegram/WhatsApp: marcas de tiempo numéricas/ISO específicas del proveedor

Si necesita la hora local, conviértala aguas abajo usando la zona horaria conocida.

## Documentos relacionados

- [Prompt del sistema](/concepts/system-prompt)
- [Zonas horarias](/concepts/timezone)
- [Mensajes](/concepts/messages)
