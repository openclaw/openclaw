---
summary: "Protocolo WebSocket del Gateway: handshake, frames, versionado"
read_when:
  - Implementando o actualizando clientes WS del gateway
  - Depurando desajustes de protocolo o fallas de conexión
  - Regenerando esquemas/modelos de protocolo
title: "Protocolo del Gateway"
---

# Protocolo del gateway (WebSocket)

El protocolo WS del Gateway es el **único plano de control + transporte de nodos** para
OpenClaw. Todos los clientes (CLI, UI web, app de macOS, nodos iOS/Android, nodos
sin cabeza) se conectan por WebSocket y declaran su **rol** + **alcance** en el
momento del handshake.

## Transporte

- WebSocket, frames de texto con payloads JSON.
- El primer frame **debe** ser una solicitud `connect`.

## Handshake (connect)

Gateway → Cliente (desafío pre-conexión):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Cliente → Gateway:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Gateway → Cliente:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

Cuando se emite un token de dispositivo, `hello-ok` también incluye:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Ejemplo de nodo

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## Framing

- **Solicitud**: `{type:"req", id, method, params}`
- **Respuesta**: `{type:"res", id, ok, payload|error}`
- **Evento**: `{type:"event", event, payload, seq?, stateVersion?}`

Los métodos con efectos secundarios requieren **claves de idempotencia** (ver esquema).

## Roles + alcances

### Roles

- `operator` = cliente del plano de control (CLI/UI/automatización).
- `node` = host de capacidades (cámara/pantalla/canvas/system.run).

### Alcances (operator)

Alcances comunes:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Capacidades/comandos/permisos (node)

Los nodos declaran reclamos de capacidad en el momento de la conexión:

- `caps`: categorías de capacidad de alto nivel.
- `commands`: lista de permitidos de comandos para invocar.
- `permissions`: toggles granulares (ej. `screen.record`, `camera.capture`).

El Gateway trata estos como **reclamos** y aplica listas de permitidos del lado del servidor.

## Presencia

- `system-presence` devuelve entradas indexadas por identidad de dispositivo.
- Las entradas de presencia incluyen `deviceId`, `roles` y `scopes` para que las UIs puedan mostrar una sola fila por dispositivo
  incluso cuando se conecta tanto como **operator** como **node**.

### Métodos auxiliares de nodo

- Los nodos pueden llamar a `skills.bins` para obtener la lista actual de ejecutables de habilidades
  para verificaciones de auto-permitidos.

## Aprobaciones de exec

- Cuando una solicitud exec necesita aprobación, el gateway transmite `exec.approval.requested`.
- Los clientes operadores resuelven llamando a `exec.approval.resolve` (requiere alcance `operator.approvals`).

## Versionado

- `PROTOCOL_VERSION` vive en `src/gateway/protocol/schema.ts`.
- Los clientes envían `minProtocol` + `maxProtocol`; el servidor rechaza desajustes.
- Los esquemas + modelos se generan a partir de definiciones TypeBox:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Autenticación

- Si `OPENCLAW_GATEWAY_TOKEN` (o `--token`) está establecido, `connect.params.auth.token`
  debe coincidir o el socket se cierra.
- Después del emparejamiento, el Gateway emite un **token de dispositivo** delimitado al rol
  de conexión + alcances. Se devuelve en `hello-ok.auth.deviceToken` y debe ser
  persistido por el cliente para futuras conexiones.
- Los tokens de dispositivo pueden rotarse/revocarse a través de `device.token.rotate` y
  `device.token.revoke` (requiere alcance `operator.pairing`).

## Identidad de dispositivo + emparejamiento

- Los nodos deben incluir una identidad de dispositivo estable (`device.id`) derivada de una
  huella digital de par de claves.
- Los Gateways emiten tokens por dispositivo + rol.
- Se requieren aprobaciones de emparejamiento para nuevos IDs de dispositivo a menos que la auto-aprobación
  local esté habilitada.
- Las conexiones **locales** incluyen bucle local y la propia dirección tailnet del host del gateway
  (para que los enlaces tailnet del mismo host aún puedan auto-aprobarse).
- Todos los clientes WS deben incluir la identidad `device` durante `connect` (operator + node).
  La UI de Control puede omitirla **solo** cuando `gateway.controlUi.allowInsecureAuth` está habilitado
  (o `gateway.controlUi.dangerouslyDisableDeviceAuth` para uso de emergencia).
- Las conexiones no locales deben firmar el nonce `connect.challenge` proporcionado por el servidor.

## TLS + pinning

- TLS es compatible con conexiones WS.
- Los clientes pueden opcionalmente fijar la huella digital del certificado del gateway (ver config `gateway.tls`
  más `gateway.remote.tlsFingerprint` o CLI `--tls-fingerprint`).

## Alcance

Este protocolo expone la **API completa del gateway** (estado, canales, modelos, chat,
agente, sesiones, nodos, aprobaciones, etc.). La superficie exacta está definida por los
esquemas TypeBox en `src/gateway/protocol/schema.ts`.
