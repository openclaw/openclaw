---
summary: "Ferramentas de sessão do agente para listar sessões, buscar histórico e enviar mensagens entre sessões"
read_when:
  - Ao adicionar ou modificar ferramentas de sessão
title: "Ferramentas de Sessão"
---

# Ferramentas de Sessão

Objetivo: conjunto de ferramentas pequeno e difícil de usar incorretamente para que agentes possam listar sessões, buscar histórico e enviar mensagens para outra sessão.

## Nomes das Ferramentas

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Modelo de Chaves

- O bucket principal de chat direto é sempre a chave literal `"main"` (resolvida para a chave principal do agente atual).
- Chats em grupo usam `agent:<agentId>:<channel>:group:<id>` ou `agent:<agentId>:<channel>:channel:<id>` (passe a chave completa).
- Jobs de cron usam `cron:<job.id>`.
- Hooks usam `hook:<uuid>` a menos que seja explicitamente definido.
- Sessões de node usam `node-<nodeId>` a menos que seja explicitamente definido.

`global` e `unknown` são valores reservados e nunca são listados. Se `session.scope = "global"`, fazemos alias para `main` em todas as ferramentas para que os chamadores nunca vejam `global`.

## sessions_list

Lista sessões como um array de linhas.

Parâmetros:

- filtro `kinds?: string[]`: qualquer um de `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` máximo de linhas (padrão: padrão do servidor, limitado, por exemplo, a 200)
- `activeMinutes?: number` apenas sessões atualizadas nos últimos N minutos
- `messageLimit?: number` 0 = sem mensagens (padrão 0); >0 = incluir as últimas N mensagens

Comportamento:

- `messageLimit > 0` busca `chat.history` por sessão e inclui as últimas N mensagens.
- Resultados de ferramentas são filtrados na saída da lista; use `sessions_history` para mensagens de ferramenta.
- Ao executar em uma sessão de agente **em sandbox**, as ferramentas de sessão usam por padrão **visibilidade apenas das sessões geradas** (veja abaixo).

Formato da linha (JSON):

- `key`: chave da sessão (string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (rótulo de exibição do grupo, se disponível)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (override de sessão, se definido)
- `lastChannel`, `lastTo`
- `deliveryContext` (`{ channel, to, accountId }` normalizado quando disponível)
- `transcriptPath` (caminho de melhor esforço derivado do diretório do store + sessionId)
- `messages?` (somente quando `messageLimit > 0`)

## sessions_history

Busca a transcrição de uma sessão.

Parâmetros:

- `sessionKey` (obrigatório; aceita chave da sessão ou `sessionId` de `sessions_list`)
- `limit?: number` máximo de mensagens (limitado pelo servidor)
- `includeTools?: boolean` (padrão false)

Comportamento:

- `includeTools=false` filtra mensagens `role: "toolResult"`.
- Retorna um array de mensagens no formato bruto da transcrição.
- Quando fornecido um `sessionId`, o OpenClaw resolve para a chave de sessão correspondente (erro se id ausente).

## sessions_send

Envia uma mensagem para outra sessão.

Parâmetros:

- `sessionKey` (obrigatório; aceita chave da sessão ou `sessionId` de `sessions_list`)
- `message` (obrigatório)
- `timeoutSeconds?: number` (padrão >0; 0 = fire-and-forget)

Comportamento:

- `timeoutSeconds = 0`: enfileira e retorna `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0`: aguarda até N segundos pela conclusão e então retorna `{ runId, status: "ok", reply }`.
- Se a espera expirar: `{ runId, status: "timeout", error }`. A execução continua; chame `sessions_history` depois.
- Se a execução falhar: `{ runId, status: "error", error }`.
- Execuções de anúncio de entrega ocorrem após a execução primária concluir e são de melhor esforço; `status: "ok"` não garante que o anúncio foi entregue.
- Aguarda via `agent.wait` do gateway (lado do servidor) para que reconexões não interrompam a espera.
- O contexto de mensagem agente‑para‑agente é injetado para a execução primária.
- Após a execução primária concluir, o OpenClaw executa um **loop de resposta de volta**:
  - A partir da rodada 2, alterna entre os agentes solicitante e alvo.
  - Responda exatamente `REPLY_SKIP` para parar o ping‑pong.
  - O máximo de turnos é `session.agentToAgent.maxPingPongTurns` (0–5, padrão 5).
- Quando o loop termina, o OpenClaw executa a **etapa de anúncio agente‑para‑agente** (somente agente alvo):
  - Responda exatamente `ANNOUNCE_SKIP` para permanecer em silêncio.
  - Qualquer outra resposta é enviada para o canal de destino.
  - A etapa de anúncio inclui a solicitação original + resposta da rodada 1 + a resposta mais recente do ping‑pong.

## Campo Channel

- Para grupos, `channel` é o canal registrado na entrada da sessão.
- Para chats diretos, `channel` mapeia a partir de `lastChannel`.
- Para cron/hook/node, `channel` é `internal`.
- Se ausente, `channel` é `unknown`.

## Segurança / Política de Envio

Bloqueio baseado em política por canal/tipo de chat (não por id de sessão).

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

Override em tempo de execução (por entrada de sessão):

- `sendPolicy: "allow" | "deny"` (não definido = herda configuração)
- Definível via `sessions.patch` ou `/send on|off|inherit` exclusivo do proprietário (mensagem independente).

Pontos de aplicação:

- `chat.send` / `agent` (gateway)
- lógica de entrega de resposta automática

## sessions_spawn

Inicia a execução de um sub‑agente em uma sessão isolada e anuncia o resultado de volta ao canal de chat do solicitante.

Parâmetros:

- `task` (obrigatório)
- `label?` (opcional; usado para logs/UI)
- `agentId?` (opcional; iniciar sob outro id de agente, se permitido)
- `model?` (opcional; sobrescreve o modelo do sub‑agente; valores inválidos geram erro)
- `runTimeoutSeconds?` (padrão 0; quando definido, aborta a execução do sub‑agente após N segundos)
- `cleanup?` (`delete|keep`, padrão `keep`)

Lista de permissões:

- `agents.list[].subagents.allowAgents`: lista de ids de agentes permitidos via `agentId` (`["*"]` para permitir qualquer). Padrão: apenas o agente solicitante.

Descoberta:

- Use `agents_list` para descobrir quais ids de agentes são permitidos para `sessions_spawn`.

Comportamento:

- Inicia uma nova sessão `agent:<agentId>:subagent:<uuid>` com `deliver: false`.
- Sub‑agentes usam por padrão o conjunto completo de ferramentas **menos ferramentas de sessão** (configurável via `tools.subagents.tools`).
- Sub‑agentes não têm permissão para chamar `sessions_spawn` (sem spawn de sub‑agente → sub‑agente).
- Sempre não bloqueante: retorna `{ status: "accepted", runId, childSessionKey }` imediatamente.
- Após a conclusão, o OpenClaw executa uma **etapa de anúncio** do sub‑agente e publica o resultado no canal de chat do solicitante.
- Responda exatamente `ANNOUNCE_SKIP` durante a etapa de anúncio para permanecer em silêncio.
- Respostas de anúncio são normalizadas para `Status`/`Result`/`Notes`; `Status` vem do resultado em tempo de execução (não do texto do modelo).
- Sessões de sub‑agente são arquivadas automaticamente após `agents.defaults.subagents.archiveAfterMinutes` (padrão: 60).
- Respostas de anúncio incluem uma linha de estatísticas (tempo de execução, tokens, sessionKey/sessionId, caminho da transcrição e custo opcional).

## Visibilidade de Sessões em Sandbox

Sessões em sandbox podem usar ferramentas de sessão, mas por padrão elas só veem as sessões que geraram via `sessions_spawn`.

Configuração:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
