---
summary: "Ferramentas de sessão de agente para listar sessões, buscar histórico e enviar mensagens entre sessões"
read_when:
  - Adicionando ou modificando ferramentas de sessão
title: "Ferramentas de Sessão"
---

# Ferramentas de Sessão

Objetivo: pequeno conjunto de ferramentas difíceis de usar incorretamente para que agentes possam listar sessões, buscar histórico e enviar para outra sessão.

## Nomes de Ferramentas

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Modelo chave

- O bucket principal de chat direto é sempre a chave literal `"main"` (resolvida para a chave principal atual do agente).
- Chats de grupo usam `agent:<agentId>:<channel>:group:<id>` ou `agent:<agentId>:<channel>:channel:<id>` (passa a chave completa).
- Cron jobs usam `cron:<job.id>`.
- Ganchos usam `hook:<uuid>` a menos que explicitamente definido.
- Sessões de nó usam `node-<nodeId>` a menos que explicitamente definido.

`global` e `unknown` são valores reservados e nunca são listados. Se `session.scope = "global"`, nós o aliasamos para `main` para todas as ferramentas para que chamadores nunca vejam `global`.

## sessions_list

Lista sessões como um array de linhas.

Parâmetros:

- `kinds?: string[]` filtro: qualquer de `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` máximo de linhas (padrão: padrão do servidor, clamp ex. 200)
- `activeMinutes?: number` apenas sessões atualizadas dentro de N minutos
- `messageLimit?: number` 0 = sem mensagens (padrão 0); >0 = incluir últimas N mensagens

Comportamento:

- `messageLimit > 0` busca `chat.history` por sessão e inclui as últimas N mensagens.
- Resultados de ferramenta são filtrados de saída de lista; use `sessions_history` para mensagens de ferramenta.
- Quando executando em uma sessão de agente **sandboxed**, ferramentas de sessão padrão para **spawned-only visibility** (veja abaixo).

Forma de linha (JSON):

- `key`: chave de sessão (string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (rótulo de exibição de grupo se disponível)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (substituição de sessão se definida)
- `lastChannel`, `lastTo`
- `deliveryContext` (normalizado `{ channel, to, accountId }` quando disponível)
- `transcriptPath` (caminho best-effort derivado de store dir + sessionId)
- `messages?` (apenas quando `messageLimit > 0`)

## sessions_history

Busca transcrição para uma sessão.

Parâmetros:

- `sessionKey` (obrigatório; aceita chave de sessão ou `sessionId` de `sessions_list`)
- `limit?: number` máximo de mensagens (server clamps)
- `includeTools?: boolean` (padrão false)

Comportamento:

- `includeTools=false` filtra mensagens `role: "toolResult"`.
- Retorna array de mensagens no formato de transcrição bruta.
- Quando dado um `sessionId`, OpenClaw o resolve para a chave de sessão correspondente (ids faltando erro).

## sessions_send

Envia mensagem para outra sessão.

Parâmetros:

- `sessionKey` (obrigatório; aceita chave de sessão ou `sessionId` de `sessions_list`)
- `message` (obrigatório)
- `timeoutSeconds?: number` (padrão >0; 0 = fire-and-forget)

Comportamento:

- `timeoutSeconds = 0`: enfilizar e retornar `{ runId, status: "accepted" }`.
