---
title: Monitoreo de autenticación
description: Monitorea el estado de autenticación del canal y recibe alertas de desconexiones
---

El monitoreo de autenticación detecta automáticamente cuándo los canales pierden la autenticación y puede alertarte a través de webhooks, hooks o tareas programadas.

## Cómo funciona

OpenClaw verifica periódicamente el estado de autenticación de los canales configurados y:
- Registra eventos de desconexión
- Activa webhooks cuando cambia el estado del canal
- Puede ejecutar hooks personalizados en eventos de autenticación
- Permite verificaciones de estado programadas mediante tareas programadas

## Configuración

### Habilitar webhooks de estado de canal

```yaml
automation:
  webhook:
    url: https://tu-dominio.com/webhooks/openclaw
    secret: tu-secreto
```

Cuando un canal se desconecta, recibirás:

```json
{
  "event": "channel.disconnected",
  "timestamp": "2025-01-18T10:35:00Z",
  "gateway_id": "gateway-123",
  "data": {
    "channel": "whatsapp",
    "account": "+1234567890",
    "reason": "Token de autenticación expirado"
  }
}
```

### Verificaciones programadas de estado

Verifica el estado del canal periódicamente usando tareas programadas:

```yaml
automation:
  cron:
    - name: verificar-estado-canal
      # Verifica cada hora
      schedule: "0 * * * *"
      command: openclaw channels status --probe
```

## Próximos pasos

- Aprende sobre [Webhooks](/es-ES/automation/webhook)
- Configura [Tareas programadas](/es-ES/automation/cron-jobs)
- Explora [Hooks](/es-ES/automation/hooks)
