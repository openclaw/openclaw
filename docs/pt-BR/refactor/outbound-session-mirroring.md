---
title: refactor/outbound-session-mirroring.md #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# Refatoração do Espelhamento de Sessões de Saída (Issue #1520)

## Status

- Em andamento.
- Roteamento de canais do core + plugins atualizado para espelhamento de saída.
- O envio pelo Gateway agora deriva a sessão de destino quando `sessionKey` é omitida.

## Contexto

Envios de saída eram espelhados na sessão _atual_ do agente (chave de sessão da ferramenta) em vez da sessão do canal de destino. O roteamento de entrada usa chaves de sessão de canal/par, então as respostas de saída caíam na sessão errada e destinos de primeiro contato frequentemente não tinham entradas de sessão.

## Objetivos

- Espelhar mensagens de saída na chave de sessão do canal de destino.
- Criar entradas de sessão na saída quando estiverem ausentes.
- Manter o escopo de thread/tópico alinhado com as chaves de sessão de entrada.
- Cobrir canais do core e extensões empacotadas.

## Resumo da Implementação

- Novo helper de roteamento de sessão de saída:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` constrói a `sessionKey` de destino usando `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` grava um `MsgContext` mínimo via `recordSessionMetaFromInbound`.
- `runMessageAction` (send) deriva a `sessionKey` de destino e a passa para `executeSendAction` para espelhamento.
- `message-tool` não espelha mais diretamente; ele apenas resolve o `agentId` a partir da chave de sessão atual.
- O caminho de envio do plugin espelha via `appendAssistantMessageToSessionTranscript` usando a `sessionKey` derivada.
- O envio pelo Gateway deriva uma chave de sessão de destino quando nenhuma é fornecida (agente padrão) e garante uma entrada de sessão.

## Tratamento de Thread/Tópico

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (sufixo).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` com `useSuffix=false` para corresponder à entrada (o id do canal de thread já delimita a sessão).
- Telegram: IDs de tópico mapeiam para `chatId:topic:<id>` via `buildTelegramGroupPeerId`.

## Extensões Cobertas

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Notas:
  - Alvos do Mattermost agora removem `@` para roteamento de chave de sessão de DM.
  - Zalo Personal usa o tipo de par de DM para alvos 1:1 (grupo apenas quando `group:` está presente).
  - Alvos de grupo do BlueBubbles removem prefixos `chat_*` para corresponder às chaves de sessão de entrada.
  - O espelhamento automático de threads do Slack corresponde a ids de canal sem diferenciar maiúsculas/minúsculas.
  - O envio pelo Gateway converte para minúsculas as chaves de sessão fornecidas antes de espelhar.

## Decisões

- **Derivação de sessão no envio pelo Gateway**: se `sessionKey` for fornecida, use-a. Se omitida, derive uma `sessionKey` a partir do destino + agente padrão e espelhe nela.
- **Criação de entrada de sessão**: sempre usar `recordSessionMetaFromInbound` com `Provider/From/To/ChatType/AccountId/Originating*` alinhado aos formatos de entrada.
- **Normalização de alvo**: o roteamento de saída usa alvos resolvidos (após `resolveChannelTarget`) quando disponíveis.
- **Capitalização da chave de sessão**: canonicalizar chaves de sessão para minúsculas na gravação e durante migrações.

## Testes Adicionados/Atualizados

- `src/infra/outbound/outbound-session.test.ts`
  - Chave de sessão de thread do Slack.
  - Chave de sessão de tópico do Telegram.
  - identityLinks de dmScope com Discord.
- `src/agents/tools/message-tool.test.ts`
  - Deriva `agentId` a partir da chave de sessão (nenhuma `sessionKey` passada adiante).
- `src/gateway/server-methods/send.test.ts`
  - Deriva a chave de sessão quando omitida e cria a entrada de sessão.

## Itens em Aberto / Acompanhamentos

- O plugin de chamada de voz usa chaves de sessão `voice:<phone>` personalizadas. O mapeamento de saída não é padronizado aqui; se a ferramenta de mensagens precisar suportar envios de chamadas de voz, adicione um mapeamento explícito.
- Confirmar se algum plugin externo usa formatos `From/To` não padronizados além do conjunto empacotado.

## Arquivos Alterados

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Testes em:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
