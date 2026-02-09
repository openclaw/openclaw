---
summary: "Política de reintentos para llamadas salientes a proveedores"
read_when:
  - Al actualizar el comportamiento o los valores predeterminados de reintento del proveedor
  - Al depurar errores de envío del proveedor o límites de velocidad
title: "Política de reintentos"
---

# Política de reintentos

## Objetivos

- Reintentar por solicitud HTTP, no por flujo de varios pasos.
- Preservar el orden reintentando solo el paso actual.
- Evitar duplicar operaciones no idempotentes.

## Valores predeterminados

- Intentos: 3
- Límite máximo de retraso: 30000 ms
- Jitter: 0.1 (10 por ciento)
- Valores predeterminados del proveedor:
  - Retraso mínimo de Telegram: 400 ms
  - Retraso mínimo de Discord: 500 ms

## Comportamiento

### Discord

- Reintenta solo en errores por límite de velocidad (HTTP 429).
- Usa `retry_after` cuando está disponible; de lo contrario, retroceso exponencial.

### Telegram

- Reintenta en errores transitorios (429, tiempo de espera, conexión/restablecimiento/cierre, temporalmente no disponible).
- Usa `retry_after` cuando está disponible; de lo contrario, retroceso exponencial.
- Los errores de análisis de Markdown no se reintentan; se usa texto sin formato como alternativa.

## Configuración

Configure la política de reintentos por proveedor en `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## Notas

- Los reintentos se aplican por solicitud (envío de mensajes, carga de medios, reacción, encuesta, sticker).
- Los flujos compuestos no reintentan los pasos completados.
