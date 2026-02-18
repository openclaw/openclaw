---
summary: "Esquemas TypeBox como a única fonte de verdade para o protocolo do gateway"
read_when:
  - Atualizando esquemas de protocolo ou codegen
title: "TypeBox"
---

# TypeBox como fonte de verdade de protocolo

Última atualização: 2026-01-10

TypeBox é uma biblioteca de schema TypeScript-first. Nós a usamos para definir o **protocolo WebSocket do Gateway** (handshake, request/response, eventos de servidor). Esses schemas impulsionam **validação de runtime**, **exportação de JSON Schema** e **codegen Swift** para o app macOS. Uma fonte de verdade; tudo mais é gerado.

Se você quer contexto de protocolo de nível mais alto, comece com [Arquitetura do Gateway](/pt-BR/concepts/architecture).

## Modelo mental (30 segundos)

Cada mensagem de WS do Gateway é uma das três frames:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion? }`

A primeira frame **deve** ser uma requisição `connect`. Depois disso, clientes podem chamar métodos (ex. `health`, `send`, `chat.send`) e se inscrever em eventos (ex. `presence`, `tick`, `agent`).

Fluxo de conexão (mínimo):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

Métodos e eventos comuns:

| Categoria | Exemplos                                                  | Notas                                     |
| --------- | --------------------------------------------------------- | ----------------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` deve ser primeiro               |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | side-effects precisam de `idempotencyKey` |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat usa estes                         |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | admin de sessão                           |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + ações de nó                  |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | server push                               |

A lista autoritária vive em `src/gateway/server.ts` (`METHODS`, `EVENTS`).

## Onde os schemas vivem

- Source: `src/gateway/protocol/schema.ts`
- Validadores de runtime (AJV): `src/gateway/protocol/index.ts`
- Handshake de servidor + dispatch de método: `src/gateway/server.ts`
- Cliente de nó: `src/gateway/client.ts`
- JSON Schema gerado: `dist/protocol.schema.json`
- Modelos Swift gerados: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Pipeline atual

- `pnpm protocol:gen`
  - escreve JSON Schema (draft-07) para `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - gera modelos gateway Swift
- `pnpm protocol:check`
  - executa ambos os geradores e verifica se a saída é committed

## Como os schemas são usados em tempo de execução

- **Lado do servidor**: cada frame de entrada é validado com AJV. O handshake apenas aceita uma requisição `connect` cujos params correspondem a `ConnectParams`.
- **Lado do cliente**: o cliente JS valida frames de evento e resposta antes de usá-los.
- **Superfície de método**: o Gateway anuncia os `methods` suportados.
