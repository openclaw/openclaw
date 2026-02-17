---
summary: "Adaptadores RPC para CLIs externos (signal-cli, imsg legacy) y patrones de gateway"
read_when:
  - Agregar o cambiar integraciones de CLI externos
  - Depurar adaptadores RPC (signal-cli, imsg)
title: "Adaptadores RPC"
---

# Adaptadores RPC

OpenClaw integra CLIs externos mediante JSON-RPC. Se usan dos patrones hoy.

## Patrón A: Daemon HTTP (signal-cli)

- `signal-cli` se ejecuta como daemon con JSON-RPC sobre HTTP.
- Stream de eventos es SSE (`/api/v1/events`).
- Sonda de salud: `/api/v1/check`.
- OpenClaw posee el ciclo de vida cuando `channels.signal.autoStart=true`.

Ver [Signal](/es-ES/channels/signal) para configuración y endpoints.

## Patrón B: Proceso hijo stdio (legacy: imsg)

> **Nota:** Para nuevas configuraciones de iMessage, usa [BlueBubbles](/es-ES/channels/bluebubbles) en su lugar.

- OpenClaw genera `imsg rpc` como proceso hijo (integración legacy de iMessage).
- JSON-RPC es delimitado por línea sobre stdin/stdout (un objeto JSON por línea).
- Sin puerto TCP, sin daemon requerido.

Métodos principales usados:

- `watch.subscribe` → notificaciones (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (sonda/diagnósticos)

Ver [iMessage](/es-ES/channels/imessage) para configuración legacy y direccionamiento (`chat_id` preferido).

## Directrices de adaptador

- Gateway posee el proceso (inicio/parada vinculado al ciclo de vida del proveedor).
- Mantén clientes RPC resistentes: timeouts, reinicio en salida.
- Prefiere IDs estables (ej., `chat_id`) sobre cadenas de visualización.
