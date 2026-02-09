---
summary: "Adaptadores RPC para CLIs externas (signal-cli, imsg legado) y patrones de Gateway"
read_when:
  - Al agregar o cambiar integraciones de CLI externas
  - Al depurar adaptadores RPC (signal-cli, imsg)
title: "Adaptadores RPC"
---

# Adaptadores RPC

OpenClaw integra CLIs externas mediante JSON-RPC. Hoy se usan dos patrones.

## Patrón A: demonio HTTP (signal-cli)

- `signal-cli` se ejecuta como un demonio con JSON-RPC sobre HTTP.
- El flujo de eventos es SSE (`/api/v1/events`).
- Sonda de salud: `/api/v1/check`.
- OpenClaw controla el ciclo de vida cuando `channels.signal.autoStart=true`.

Consulte [Signal](/channels/signal) para la configuración y los endpoints.

## Patrón B: proceso hijo stdio (legado: imsg)

> **Nota:** Para nuevas configuraciones de iMessage, use [BlueBubbles](/channels/bluebubbles) en su lugar.

- OpenClaw inicia `imsg rpc` como un proceso hijo (integración legada de iMessage).
- JSON-RPC está delimitado por líneas sobre stdin/stdout (un objeto JSON por línea).
- Sin puerto TCP; no se requiere demonio.

Métodos principales utilizados:

- `watch.subscribe` → notificaciones (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (sondeo/diagnósticos)

Consulte [iMessage](/channels/imessage) para la configuración legada y el direccionamiento (`chat_id` preferido).

## Directrices del adaptador

- El Gateway es dueño del proceso (inicio/detención vinculados al ciclo de vida del proveedor).
- Mantenga los clientes RPC resilientes: tiempos de espera, reinicio al salir.
- Prefiera IDs estables (p. ej., `chat_id`) sobre cadenas de visualización.
