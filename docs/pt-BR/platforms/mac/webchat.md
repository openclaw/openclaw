---
summary: "Como o app para mac incorpora o WebChat do gateway e como depurá-lo"
read_when:
  - Depuração da visualização WebChat no mac ou da porta de loopback
title: "WebChat"
---

# WebChat (app macOS)

O app de barra de menu do macOS incorpora a interface do WebChat como uma visualização SwiftUI nativa. Ele
se conecta ao Gateway e, por padrão, usa a **sessão principal** do agente selecionado
(com um seletor de sessões para outras sessões).

- **Modo local**: conecta-se diretamente ao WebSocket local do Gateway.
- **Modo remoto**: encaminha a porta de controle do Gateway via SSH e usa esse
  túnel como plano de dados.

## Inicialização e depuração

- Manual: menu Lobster → “Open Chat”.

- Abertura automática para testes:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Logs: `./scripts/clawlog.sh` (subsystem `bot.molt`, category `WebChatSwiftUI`).

## Como está conectado

- Plano de dados: métodos WS do Gateway `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` e eventos `chat`, `agent`, `presence`, `tick`, `health`.
- Sessão: por padrão usa a sessão primária (`main`, ou `global` quando o escopo é
  global). A UI pode alternar entre sessões.
- A integração inicial usa uma sessão dedicada para manter a configuração da primeira execução separada.

## Superfície de segurança

- O modo remoto encaminha apenas a porta de controle WebSocket do Gateway via SSH.

## Limitações conhecidas

- A UI é otimizada para sessões de chat (não é um sandbox de navegador completo).
