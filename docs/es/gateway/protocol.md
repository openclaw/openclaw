---
summary: "Protocolo WebSocket del Gateway: handshake, tramas, versionado"
read_when:
  - Implementar o actualizar clientes WS del Gateway
  - Depurar desajustes de protocolo o fallas de conexión
  - Regenerar esquemas/modelos del protocolo
title: "Protocolo del Gateway"
---

# Protocolo del Gateway (WebSocket)

El protocolo WS del Gateway es el **plano de control único + transporte de nodos** para
OpenClaw. Todos los clientes (CLI, UI web, app de macOS, nodos iOS/Android, nodos
headless) se conectan por WebSocket y declaran su **rol** + **alcance** en el
momento del handshake.

## Transporte

- WebSocket, tramas de texto con payloads JSON.
- La primera trama **debe** ser una solicitud `connect`.

## Handshake (conexión)

Gateway → Cliente (desafío previo a la conexión):

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

## Enmarcando

- **Solicitud**: `{type:"req", id, method, params}`
- **Respuesta**: `{type:"res", id, ok, payload|error}`
- **Evento**: `{type:"event", event, payload, seq?, stateVersion?}`

Los métodos con efectos secundarios requieren **claves de idempotencia** (ver el esquema).

## Roles + alcances

### Roles

- `operator` = cliente del plano de control (CLI/UI/automatización).
- `node` = host de capacidades (camera/screen/canvas/system.run).

### Alcances (operador)

Alcances comunes:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/comandos/permisos (node)

Los nodos declaran reclamaciones de capacidades al momento de conectarse:

- `caps`: categorías de capacidades de alto nivel.
- `commands`: lista de permitidos de comandos para invocar.
- `permissions`: conmutadores granulares (p. ej., `screen.record`, `camera.capture`).

El Gateway trata esto como **reclamaciones** y aplica listas de permitidos del lado del servidor.

## Presencia

- `system-presence` devuelve entradas indexadas por identidad del dispositivo.
- Las entradas de presencia incluyen `deviceId`, `roles` y `scopes` para que las UIs puedan mostrar una sola fila por dispositivo
  incluso cuando se conecta como **operador** y **nodo**.

### Métodos auxiliares del nodo

- Los nodos pueden llamar a `skills.bins` para obtener la lista actual de ejecutables de Skills
  para comprobaciones de auto‑permitir.

## Aprobaciones de exec

- Cuando una solicitud de exec necesita aprobación, el gateway difunde `exec.approval.requested`.
- Los clientes operadores resuelven llamando a `exec.approval.resolve` (requiere el alcance `operator.approvals`).

## Versionado

- `PROTOCOL_VERSION` vive en `src/gateway/protocol/schema.ts`.
- Los clientes envían `minProtocol` + `maxProtocol`; el servidor rechaza incompatibilidades.
- Los esquemas + modelos se generan a partir de definiciones TypeBox:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Autenticación

- Si se establece `OPENCLAW_GATEWAY_TOKEN` (o `--token`), `connect.params.auth.token`
  debe coincidir o el socket se cierra.
- Tras el emparejamiento, el Gateway emite un **token de dispositivo** con alcance según el
  rol + alcances de la conexión. Se devuelve en `hello-ok.auth.deviceToken` y debe
  persistirse por el cliente para conexiones futuras.
- Los tokens de dispositivo pueden rotarse/revocarse mediante `device.token.rotate` y
  `device.token.revoke` (requiere el alcance `operator.pairing`).

## Identidad del dispositivo + emparejamiento

- Los nodos deben incluir una identidad de dispositivo estable (`device.id`) derivada de la
  huella de un par de claves.
- Los Gateways emiten tokens por dispositivo + rol.
- Se requieren aprobaciones de emparejamiento para nuevos IDs de dispositivo, a menos que esté habilitada la autoaprobación local.
- Las conexiones **locales** incluyen loopback y la propia dirección tailnet del host del gateway
  (de modo que los enlaces tailnet en el mismo host aún puedan autoaprobarse).
- Todos los clientes WS deben incluir la identidad `device` durante `connect` (operador + nodo).
  La UI de control puede omitirla **solo** cuando `gateway.controlUi.allowInsecureAuth` está habilitado
  (o `gateway.controlUi.dangerouslyDisableDeviceAuth` para uso de emergencia).
- Las conexiones no locales deben firmar el nonce `connect.challenge` proporcionado por el servidor.

## TLS + pinning

- TLS es compatible para conexiones WS.
- Los clientes pueden opcionalmente fijar (pin) la huella del certificado del gateway (ver la configuración `gateway.tls`
  además de `gateway.remote.tlsFingerprint` o la CLI `--tls-fingerprint`).

## Alcance

Este protocolo expone la **API completa del gateway** (estado, canales, modelos, chat,
agente, sesiones, nodos, aprobaciones, etc.). La superficie exacta está definida por los
esquemas TypeBox en `src/gateway/protocol/schema.ts`.
