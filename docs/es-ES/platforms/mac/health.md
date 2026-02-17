---
title: Verificaciones de Salud
description: Sistema de monitoreo de salud del gateway de macOS
---

# Verificaciones de Salud

La app de macOS de OpenClaw monitorea continuamente la salud del gateway para asegurar operación confiable.

## Endpoint de Salud

El gateway expone un endpoint de salud en:

```
http://localhost:18789/health
```

### Formato de Respuesta

```json
{
  "status": "healthy",
  "uptime": 3600,
  "version": "2026.2.16",
  "connections": {
    "active": 3,
    "total": 15
  }
}
```

## Monitoreo

### Intervalo de Sondeo

- **Intervalo normal**: cada 30 segundos
- **Intervalo de error**: cada 5 segundos (después de fallos)
- **Timeout**: 10 segundos por solicitud

### Indicadores de Salud

1. **Estado Saludable** (verde): Gateway respondiendo normalmente
2. **Estado Degradado** (amarillo): Respuestas lentas o errores intermitentes
3. **Estado No Saludable** (rojo): Sin respuesta o errores persistentes

## Manejo de Errores

### Fallos de Conexión

- Reintentos automáticos (hasta 3 intentos)
- Backoff exponencial entre reintentos
- Notificación al usuario después de fallos persistentes

### Recuperación

1. Reintentar conexión al gateway
2. Si falla, intentar reiniciar el gateway
3. Si aún falla, notificar al usuario

## Depuración

Ver el estado de salud:

```bash
# Verificar manualmente
curl http://localhost:18789/health

# Monitorear continuamente
watch -n 1 'curl -s http://localhost:18789/health | jq'
```
