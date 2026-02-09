---
summary: "Como as entradas de presença do OpenClaw são produzidas, mescladas e exibidas"
read_when:
  - Depurando a aba Instances
  - Investigando linhas de instâncias duplicadas ou obsoletas
  - Alterando conexões WS do gateway ou beacons de eventos do sistema
title: "Presença"
---

# Presença

A “presença” do OpenClaw é uma visão leve e de melhor esforço de:

- o próprio **Gateway**, e
- **clientes conectados ao Gateway** (app para macOS, WebChat, CLI, etc.)

A presença é usada principalmente para renderizar a aba **Instances** do app para macOS e para
fornecer visibilidade rápida ao operador.

## Campos de presença (o que aparece)

As entradas de presença são objetos estruturados com campos como:

- `instanceId` (opcional, mas fortemente recomendado): identidade estável do cliente (geralmente `connect.client.instanceId`)
- `host`: nome do host amigável
- `ip`: endereço IP de melhor esforço
- `version`: string de versão do cliente
- `deviceFamily` / `modelIdentifier`: indícios de hardware
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: “segundos desde a última entrada do usuário” (se conhecido)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: carimbo de data/hora da última atualização (ms desde a época)

## Produtores (de onde a presença vem)

As entradas de presença são produzidas por várias fontes e **mescladas**.

### 1. Entrada do próprio Gateway

O Gateway sempre inicializa uma entrada “self” na inicialização para que as UIs mostrem o host do gateway
mesmo antes de qualquer cliente se conectar.

### 2. Conexão WebSocket

Todo cliente WS começa com uma solicitação `connect`. Em um handshake bem-sucedido, o
Gateway faz um upsert de uma entrada de presença para essa conexão.

#### Por que comandos pontuais da CLI não aparecem

A CLI frequentemente se conecta para comandos curtos e pontuais. Para evitar poluir a
lista de Instances, `client.mode === "cli"` **não** é transformado em uma entrada de presença.

### 3. Beacons `system-event`

Os clientes podem enviar beacons periódicos mais ricos por meio do método `system-event`. O app para macOS
usa isso para relatar nome do host, IP e `lastInputSeconds`.

### 4. Conexões de node (papel: node)

Quando um node se conecta pelo WebSocket do Gateway com `role: node`, o Gateway
faz um upsert de uma entrada de presença para esse node (mesmo fluxo de outros clientes WS).

## Regras de mesclagem + deduplicação (por que `instanceId` importa)

As entradas de presença são armazenadas em um único mapa em memória:

- As entradas são indexadas por uma **chave de presença**.
- A melhor chave é um `instanceId` estável (de `connect.client.instanceId`) que sobrevive a reinicializações.
- As chaves não diferenciam maiúsculas de minúsculas.

Se um cliente se reconectar sem um `instanceId` estável, ele pode aparecer como uma
linha **duplicada**.

## TTL e tamanho limitado

A presença é intencionalmente efêmera:

- **TTL:** entradas com mais de 5 minutos são removidas
- **Máx. de entradas:** 200 (as mais antigas são descartadas primeiro)

Isso mantém a lista atualizada e evita crescimento de memória sem limites.

## Observação sobre remoto/túnel (IPs de loopback)

Quando um cliente se conecta por um túnel SSH / encaminhamento de porta local, o Gateway pode
ver o endereço remoto como `127.0.0.1`. Para evitar sobrescrever um IP informado corretamente pelo cliente,
endereços remotos de loopback são ignorados.

## Consumidores

### Aba Instances do macOS

O app para macOS renderiza a saída de `system-presence` e aplica um pequeno indicador de status
(Ativo/Ocioso/Obsoleto) com base na idade da última atualização.

## Dicas de depuração

- Para ver a lista bruta, chame `system-presence` no Gateway.
- Se você vir duplicatas:
  - confirme que os clientes enviam um `client.instanceId` estável no handshake
  - confirme que os beacons periódicos usam o mesmo `instanceId`
  - verifique se a entrada derivada da conexão está sem `instanceId` (duplicatas são esperadas)
