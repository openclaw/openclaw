---
summary: "Como entradas de presença do OpenClaw são produzidas, mescladas e exibidas"
read_when:
  - Debugando a aba Instances
  - Investigando linhas de instância duplicadas ou obsoletas
  - Mudando beacons de connect WS ou system-event do gateway
title: "Presença"
---

# Presença

"Presença" do OpenClaw é uma visão lightweight e best-effort de:

- o **Gateway** em si, e
- **clientes conectados ao Gateway** (app mac, WebChat, CLI, etc.)

Presença é usada principalmente para renderizar a aba **Instances** do app macOS e fornecer visibilidade rápida de operador.

## Campos de Presença (o que aparece)

Entradas de presença são objetos estruturados com campos como:

- `instanceId` (opcional mas fortemente recomendado): identidade de cliente estável (geralmente `connect.client.instanceId`)
- `host`: nome de host amigável
- `ip`: endereço IP best-effort
- `version`: string de versão do cliente
- `deviceFamily` / `modelIdentifier`: dicas de hardware
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: "segundos desde última entrada de usuário" (se conhecido)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: último timestamp de atualização (ms desde epoch)

## Produtores (de onde presença vem)

Entradas de presença são produzidas por múltiplas fontes e **mescladas**.

### 1) Entrada self do Gateway

O Gateway sempre planta uma entrada "self" na inicialização para que interfaces mostrem o host do gateway mesmo antes de qualquer cliente conectar.

### 2) WebSocket connect

Cada cliente WS começa com uma requisição `connect`. No handshake bem-sucedido o Gateway upserts uma entrada de presença para aquela conexão.

#### Por que comandos CLI one-off não aparecem

O CLI frequentemente se conecta por comandos curtos e one-off. Para evitar spam na lista de Instances, `client.mode === "cli"` está **não** transformado em uma entrada de presença.

### 3) Beacons `system-event`

Clientes podem enviar beacons periódicos mais ricos via método `system-event`. O app mac usa isso para relatar hostname, IP e `lastInputSeconds`.

### 4) Node connects (role: node)

Quando um nó se conecta sobre o WebSocket do Gateway com `role: node`, o Gateway upserts uma entrada de presença para aquele nó (mesmo fluxo que outros clientes WS).

## Merge + regras de dedupe (por que `instanceId` importa)

Entradas de presença são armazenadas em um único mapa na memória:

- Entradas são keyed por uma **chave de presença**.
- A melhor chave é um `instanceId` estável (de `connect.client.instanceId`) que sobrevive reinicializações.
- Chaves são case-insensitive.

Se um cliente se reconecta sem um `instanceId` estável, ele pode aparecer como uma linha **duplicada**.

## TTL e tamanho limitado

Presença é intencionalmente efêmera:

- **TTL:** entradas mais antigas que 5 minutos são podadas
- **Max entradas:** 200 (mais antigas descartadas primeiro)
