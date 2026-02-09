---
summary: "Host estático do WebChat em loopback e uso de WS do Gateway para a UI de chat"
read_when:
  - Depuração ou configuração do acesso ao WebChat
title: "WebChat"
---

# WebChat (UI WebSocket do Gateway)

Status: a UI de chat SwiftUI no macOS/iOS se comunica diretamente com o WebSocket do Gateway.

## O que é

- Uma UI de chat nativa para o gateway (sem navegador embutido e sem servidor estático local).
- Usa as mesmas sessões e regras de roteamento que outros canais.
- Roteamento determinístico: as respostas sempre retornam para o WebChat.

## Início rápido

1. Inicie o gateway.
2. Abra a UI do WebChat (app macOS/iOS) ou a aba de chat da UI de Controle.
3. Garanta que a autenticação do gateway esteja configurada (obrigatória por padrão, mesmo em loopback).

## Como funciona (comportamento)

- A UI se conecta ao WebSocket do Gateway e usa `chat.history`, `chat.send` e `chat.inject`.
- `chat.inject` adiciona uma nota do assistente diretamente à transcrição e a transmite para a UI (sem execução de agente).
- O histórico é sempre buscado no gateway (sem monitoramento de arquivos locais).
- Se o gateway estiver inacessível, o WebChat fica somente leitura.

## Uso remoto

- O modo remoto encapsula o WebSocket do gateway via SSH/Tailscale.
- Você não precisa executar um servidor WebChat separado.

## Referência de configuração (WebChat)

Configuração completa: [Configuração](/gateway/configuration)

Opções do canal:

- Não há um bloco dedicado `webchat.*`. O WebChat usa o endpoint do gateway + as configurações de autenticação abaixo.

Opções globais relacionadas:

- `gateway.port`, `gateway.bind`: host/porta do WebSocket.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: autenticação do WebSocket.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: destino do gateway remoto.
- `session.*`: armazenamento de sessão e padrões da chave principal.
