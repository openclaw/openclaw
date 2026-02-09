---
summary: "Manejo de zonas horarias para agentes, sobres y prompts"
read_when:
  - Necesita comprender cómo se normalizan las marcas de tiempo para el modelo
  - Configurar la zona horaria del usuario para los prompts del sistema
title: "Zonas horarias"
---

# Zonas horarias

OpenClaw estandariza las marcas de tiempo para que el modelo vea una **única referencia temporal**.

## Sobres de mensajes (local por defecto)

Los mensajes entrantes se envuelven en un sobre como:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

La marca de tiempo en el sobre es **local del host por defecto**, con precisión de minutos.

Puede anular esto con:

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
- `envelopeTimezone: "user"` usa `agents.defaults.userTimezone` (vuelve a la zona horaria del host).
- Use una zona horaria IANA explícita (p. ej., `"Europe/Vienna"`) para un desfase fijo.
- `envelopeTimestamp: "off"` elimina las marcas de tiempo absolutas de los encabezados del sobre.
- `envelopeElapsed: "off"` elimina los sufijos de tiempo transcurrido (el estilo `+2m`).

### Ejemplos

**Local (por defecto):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Zona horaria fija:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Tiempo transcurrido:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Cargas útiles de herramientas (datos sin procesar del proveedor + campos normalizados)

Las llamadas a herramientas (`channels.discord.readMessages`, `channels.slack.readMessages`, etc.) devuelven **marcas de tiempo sin procesar del proveedor**.
También adjuntamos campos normalizados para mantener la consistencia:

- `timestampMs` (milisegundos de época UTC)
- `timestampUtc` (cadena UTC ISO 8601)

Se conservan los campos sin procesar del proveedor.

## Zona horaria del usuario para el prompt del sistema

Establezca `agents.defaults.userTimezone` para indicar al modelo la zona horaria local del usuario. Si no se establece,
OpenClaw resuelve la **zona horaria del host en tiempo de ejecución** (sin escritura de configuración).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

El prompt del sistema incluye:

- sección `Current Date & Time` con la hora local y la zona horaria
- `Time format: 12-hour` o `24-hour`

Puede controlar el formato del prompt con `agents.defaults.timeFormat` (`auto` | `12` | `24`).

Consulte [Fecha y hora](/date-time) para conocer el comportamiento completo y ver ejemplos.
