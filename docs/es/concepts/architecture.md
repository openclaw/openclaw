---
summary: "Arquitectura del Gateway WebSocket, componentes y flujos de clientes"
read_when:
  - Al trabajar en el protocolo del Gateway, clientes o transportes
title: "Arquitectura del Gateway"
x-i18n:
  source_path: concepts/architecture.md
  source_hash: 14079136faa267d7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:33:11Z
---

# Arquitectura del Gateway

Última actualización: 2026-01-22

## Descripción general

- Un único **Gateway** de larga duración es propietario de todas las superficies de mensajería (WhatsApp vía
  Baileys, Telegram vía grammY, Slack, Discord, Signal, iMessage, WebChat).
- Los clientes del plano de control (app macOS, CLI, UI web, automatizaciones) se conectan al
  Gateway por **WebSocket** en el host de enlace configurado (predeterminado
  `127.0.0.1:18789`).
- Los **Nodos** (macOS/iOS/Android/headless) también se conectan por **WebSocket**, pero
  declaran `role: node` con capacidades/comandos explícitos.
- Un Gateway por host; es el único lugar que abre una sesión de WhatsApp.
- Un **host de lienzo** (predeterminado `18793`) sirve HTML editable por el agente y A2UI.

## Componentes y flujos

### Gateway (daemon)

- Mantiene conexiones con proveedores.
- Expone una API WS tipada (solicitudes, respuestas, eventos push del servidor).
- Valida tramas entrantes contra JSON Schema.
- Emite eventos como `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron`.

### Clientes (app mac / CLI / admin web)

- Una conexión WS por cliente.
- Envían solicitudes (`health`, `status`, `send`, `agent`, `system-presence`).
- Se suscriben a eventos (`tick`, `agent`, `presence`, `shutdown`).

### Nodos (macOS / iOS / Android / headless)

- Se conectan al **mismo servidor WS** con `role: node`.
- Proporcionan una identidad de dispositivo en `connect`; el emparejamiento es **basado en dispositivo** (rol `node`) y
  la aprobación vive en el almacén de emparejamiento de dispositivos.
- Exponen comandos como `canvas.*`, `camera.*`, `screen.record`, `location.get`.

Detalles del protocolo:

- [Protocolo del Gateway](/gateway/protocol)

### WebChat

- UI estática que usa la API WS del Gateway para el historial de chat y envíos.
- En configuraciones remotas, se conecta a través del mismo túnel SSH/Tailscale que otros
  clientes.

## Ciclo de vida de la conexión (cliente único)

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## Protocolo de cable (resumen)

- Transporte: WebSocket, tramas de texto con cargas JSON.
- La primera trama **debe** ser `connect`.
- Después del handshake:
  - Solicitudes: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Eventos: `{type:"event", event, payload, seq?, stateVersion?}`
- Si `OPENCLAW_GATEWAY_TOKEN` (o `--token`) está establecido, `connect.params.auth.token`
  debe coincidir o el socket se cierra.
- Las claves de idempotencia son obligatorias para métodos con efectos secundarios (`send`, `agent`) para
  reintentar de forma segura; el servidor mantiene una caché de desduplicación de corta duración.
- Los nodos deben incluir `role: "node"` más capacidades/comandos/permisos en `connect`.

## Emparejamiento + confianza local

- Todos los clientes WS (operadores + nodos) incluyen una **identidad de dispositivo** en `connect`.
- Los nuevos IDs de dispositivo requieren aprobación de emparejamiento; el Gateway emite un **token de dispositivo**
  para conexiones posteriores.
- Las conexiones **locales** (loopback o la dirección tailnet del propio host del Gateway) pueden
  aprobarse automáticamente para mantener una UX fluida en el mismo host.
- Las conexiones **no locales** deben firmar el nonce `connect.challenge` y requieren
  aprobación explícita.
- La autenticación del Gateway (`gateway.auth.*`) sigue aplicando a **todas** las conexiones, locales o
  remotas.

Detalles: [Protocolo del Gateway](/gateway/protocol), [Emparejamiento](/channels/pairing),
[Seguridad](/gateway/security).

## Tipado del protocolo y codegen

- Los esquemas TypeBox definen el protocolo.
- JSON Schema se genera a partir de esos esquemas.
- Los modelos Swift se generan a partir del JSON Schema.

## Acceso remoto

- Preferido: Tailscale o VPN.
- Alternativa: túnel SSH

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- El mismo handshake + token de autenticación aplican sobre el túnel.
- TLS + fijación opcional pueden habilitarse para WS en configuraciones remotas.

## Instantánea de operaciones

- Inicio: `openclaw gateway` (en primer plano, registros a stdout).
- Salud: `health` por WS (también incluido en `hello-ok`).
- Supervisión: launchd/systemd para reinicio automático.

## Invariantes

- Exactamente un Gateway controla una única sesión de Baileys por host.
- El handshake es obligatorio; cualquier primera trama no JSON o no connect es un cierre inmediato.
- Los eventos no se reproducen; los clientes deben refrescar ante lagunas.
