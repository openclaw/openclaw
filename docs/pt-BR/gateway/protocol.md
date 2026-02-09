---
summary: "Protocolo WebSocket do Gateway: handshake, frames, versionamento"
read_when:
  - Implementando ou atualizando clientes WS do gateway
  - Depurando incompatibilidades de protocolo ou falhas de conexão
  - Regenerando esquema/modelos do protocolo
title: "Protocolo do Gateway"
---

# Protocolo do Gateway (WebSocket)

O protocolo WS do Gateway é o **plano de controle único + transporte de nós** do
OpenClaw. Todos os clientes (CLI, UI web, app macOS, nós iOS/Android, nós headless)
conectam via WebSocket e declaram seu **papel** + **escopo** no momento do
handshake.

## Transporte

- WebSocket, frames de texto com payloads JSON.
- O primeiro frame **deve** ser uma solicitação `connect`.

## Handshake (conexão)

Gateway → Cliente (desafio pré-conexão):

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

Quando um token de dispositivo é emitido, `hello-ok` também inclui:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Exemplo de nó

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

## Moldura

- **Request**: `{type:"req", id, method, params}`
- **Response**: `{type:"res", id, ok, payload|error}`
- **Event**: `{type:"event", event, payload, seq?, stateVersion?}`

Métodos com efeitos colaterais exigem **chaves de idempotência** (veja o esquema).

## Funções + Âmbitos

### Papéis

- `operator` = cliente do plano de controle (CLI/UI/automação).
- `node` = host de capacidades (camera/screen/canvas/system.run).

### Escopos (operador)

Escopos comuns:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/comandos/permissões (nó)

Os nós declaram reivindicações de capacidade no momento da conexão:

- `caps`: categorias de capacidade de alto nível.
- `commands`: lista de permissões de comandos para invocação.
- `permissions`: alternâncias granulares (por exemplo, `screen.record`, `camera.capture`).

O Gateway trata isso como **reivindicações** e aplica listas de permissões no lado do servidor.

## Presença

- `system-presence` retorna entradas indexadas pela identidade do dispositivo.
- As entradas de presença incluem `deviceId`, `roles` e `scopes` para que as UIs possam mostrar uma única linha por dispositivo
  mesmo quando ele se conecta como **operador** e **nó**.

### Métodos auxiliares do nó

- Os nós podem chamar `skills.bins` para buscar a lista atual de executáveis de skills
  para verificações de auto-allow.

## Aprovações de execução

- Quando uma solicitação de execução precisa de aprovação, o gateway transmite `exec.approval.requested`.
- Clientes operadores resolvem chamando `exec.approval.resolve` (exige o escopo `operator.approvals`).

## Versionamento

- `PROTOCOL_VERSION` vive em `src/gateway/protocol/schema.ts`.
- Os clientes enviam `minProtocol` + `maxProtocol`; o servidor rejeita incompatibilidades.
- Esquemas + modelos são gerados a partir de definições TypeBox:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Autenticação

- Se `OPENCLAW_GATEWAY_TOKEN` (ou `--token`) estiver definido, `connect.params.auth.token`
  deve corresponder ou o socket é fechado.
- Após o pareamento, o Gateway emite um **token de dispositivo** com escopo para o papel + escopos da conexão. Ele é retornado em `hello-ok.auth.deviceToken` e deve ser
  persistido pelo cliente para conexões futuras.
- Tokens de dispositivo podem ser rotacionados/revogados via `device.token.rotate` e
  `device.token.revoke` (exige o escopo `operator.pairing`).

## Identidade do dispositivo + pareamento

- Os nós devem incluir uma identidade de dispositivo estável (`device.id`) derivada de uma
  impressão digital de par de chaves.
- Gateways emitem tokens por dispositivo + papel.
- Aprovações de pareamento são necessárias para novos IDs de dispositivo, a menos que a aprovação automática local esteja habilitada.
- Conexões **locais** incluem loopback e o próprio endereço tailnet do host do gateway
  (assim, vínculos tailnet no mesmo host ainda podem ter aprovação automática).
- Todos os clientes WS devem incluir a identidade `device` durante `connect` (operador + nó).
  A UI de controle pode omiti-la **somente** quando `gateway.controlUi.allowInsecureAuth` estiver habilitado
  (ou `gateway.controlUi.dangerouslyDisableDeviceAuth` para uso de break-glass).
- Conexões não locais devem assinar o nonce `connect.challenge` fornecido pelo servidor.

## TLS + pinagem

- TLS é suportado para conexões WS.
- Os clientes podem opcionalmente fixar (pin) a impressão digital do certificado do gateway (veja a configuração `gateway.tls`
  além de `gateway.remote.tlsFingerprint` ou a CLI `--tls-fingerprint`).

## Enquadramento

Este protocolo expõe a **API completa do gateway** (status, canais, modelos, chat,
agente, sessões, nós, aprovações, etc.). A superfície exata é definida pelos
esquemas TypeBox em `src/gateway/protocol/schema.ts`.
