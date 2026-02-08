---
summary: "Subagentes: criação de execuções de agentes isoladas que anunciam resultados de volta ao chat solicitante"
read_when:
  - Você quer trabalho em segundo plano/paralelo via o agente
  - Você está alterando sessions_spawn ou a política de ferramentas de subagentes
title: "Subagentes"
x-i18n:
  source_path: tools/subagents.md
  source_hash: 3c83eeed69a65dbb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:20Z
---

# Subagentes

Subagentes são execuções de agentes em segundo plano criadas a partir de uma execução de agente existente. Eles são executados em sua própria sessão (`agent:<agentId>:subagent:<uuid>`) e, quando finalizados, **anunciam** o resultado de volta ao canal de chat solicitante.

## Comando de barra

Use `/subagents` para inspecionar ou controlar execuções de subagentes para a **sessão atual**:

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` mostra metadados da execução (status, carimbos de data/hora, id da sessão, caminho da transcrição, limpeza).

Objetivos principais:

- Paralelizar trabalho de “pesquisa / tarefa longa / ferramenta lenta” sem bloquear a execução principal.
- Manter subagentes isolados por padrão (separação de sessão + sandboxing opcional).
- Manter a superfície de ferramentas difícil de usar incorretamente: subagentes **não** recebem ferramentas de sessão por padrão.
- Evitar expansão aninhada: subagentes não podem criar subagentes.

Nota de custo: cada subagente tem seu **próprio** contexto e uso de tokens. Para tarefas pesadas ou repetitivas, defina um modelo mais barato para subagentes e mantenha seu agente principal em um modelo de maior qualidade. Você pode configurar isso via `agents.defaults.subagents.model` ou substituições por agente.

## Ferramenta

Use `sessions_spawn`:

- Inicia uma execução de subagente (`deliver: false`, pista global: `subagent`)
- Em seguida executa uma etapa de anúncio e publica a resposta de anúncio no canal de chat solicitante
- Modelo padrão: herda do chamador, a menos que você defina `agents.defaults.subagents.model` (ou por agente `agents.list[].subagents.model`); um `sessions_spawn.model` explícito ainda prevalece.
- Pensamento padrão: herda do chamador, a menos que você defina `agents.defaults.subagents.thinking` (ou por agente `agents.list[].subagents.thinking`); um `sessions_spawn.thinking` explícito ainda prevalece.

Parâmetros da ferramenta:

- `task` (obrigatório)
- `label?` (opcional)
- `agentId?` (opcional; cria sob outro id de agente se permitido)
- `model?` (opcional; substitui o modelo do subagente; valores inválidos são ignorados e o subagente é executado no modelo padrão com um aviso no resultado da ferramenta)
- `thinking?` (opcional; substitui o nível de pensamento para a execução do subagente)
- `runTimeoutSeconds?` (padrão `0`; quando definido, a execução do subagente é abortada após N segundos)
- `cleanup?` (`delete|keep`, padrão `keep`)

Lista de permissões:

- `agents.list[].subagents.allowAgents`: lista de ids de agente que podem ser alvo via `agentId` (`["*"]` para permitir qualquer). Padrão: apenas o agente solicitante.

Descoberta:

- Use `agents_list` para ver quais ids de agente estão atualmente permitidos para `sessions_spawn`.

Arquivamento automático:

- Sessões de subagentes são arquivadas automaticamente após `agents.defaults.subagents.archiveAfterMinutes` (padrão: 60).
- O arquivamento usa `sessions.delete` e renomeia a transcrição para `*.deleted.<timestamp>` (mesma pasta).
- `cleanup: "delete"` arquiva imediatamente após o anúncio (ainda mantém a transcrição via renomeação).
- O arquivamento automático é de melhor esforço; temporizadores pendentes são perdidos se o gateway reiniciar.
- `runTimeoutSeconds` **não** arquiva automaticamente; apenas interrompe a execução. A sessão permanece até o arquivamento automático.

## Autenticação

A autenticação de subagentes é resolvida por **id do agente**, não pelo tipo de sessão:

- A chave de sessão do subagente é `agent:<agentId>:subagent:<uuid>`.
- O armazenamento de autenticação é carregado a partir do `agentDir` desse agente.
- Os perfis de autenticação do agente principal são mesclados como **fallback**; perfis do agente substituem perfis do principal em conflitos.

Nota: a mesclagem é aditiva, portanto os perfis principais estão sempre disponíveis como fallback. Autenticação totalmente isolada por agente ainda não é suportada.

## Anúncio

Subagentes reportam de volta por meio de uma etapa de anúncio:

- A etapa de anúncio é executada dentro da sessão do subagente (não da sessão solicitante).
- Se o subagente responder exatamente `ANNOUNCE_SKIP`, nada é publicado.
- Caso contrário, a resposta de anúncio é publicada no canal de chat solicitante por meio de uma chamada `agent` de acompanhamento (`deliver=true`).
- As respostas de anúncio preservam o roteamento de thread/tópico quando disponível (threads do Slack, tópicos do Telegram, threads do Matrix).
- Mensagens de anúncio são normalizadas para um modelo estável:
  - `Status:` derivado do resultado da execução (`success`, `error`, `timeout` ou `unknown`).
  - `Result:` o conteúdo de resumo da etapa de anúncio (ou `(not available)` se ausente).
  - `Notes:` detalhes de erro e outro contexto útil.
- `Status` não é inferido da saída do modelo; vem de sinais de resultado em tempo de execução.

Cargas úteis de anúncio incluem uma linha de estatísticas ao final (mesmo quando encapsuladas):

- Tempo de execução (por exemplo, `runtime 5m12s`)
- Uso de tokens (entrada/saída/total)
- Custo estimado quando a precificação do modelo está configurada (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId` e caminho da transcrição (para que o agente principal possa buscar histórico via `sessions_history` ou inspecionar o arquivo no disco)

## Política de Ferramentas (ferramentas de subagentes)

Por padrão, subagentes recebem **todas as ferramentas exceto ferramentas de sessão**:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Substituir via configuração:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## Concorrência

Subagentes usam uma pista de fila dedicada em processo:

- Nome da pista: `subagent`
- Concorrência: `agents.defaults.subagents.maxConcurrent` (padrão `8`)

## Interrupção

- Enviar `/stop` no chat solicitante aborta a sessão solicitante e interrompe quaisquer execuções ativas de subagentes criadas a partir dela.

## Limitações

- O anúncio de subagentes é de **melhor esforço**. Se o gateway reiniciar, trabalhos pendentes de “anunciar de volta” são perdidos.
- Subagentes ainda compartilham os mesmos recursos de processo do gateway; trate `maxConcurrent` como uma válvula de segurança.
- `sessions_spawn` é sempre não bloqueante: retorna `{ status: "accepted", runId, childSessionKey }` imediatamente.
- O contexto do subagente injeta apenas `AGENTS.md` + `TOOLS.md` (sem `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` ou `BOOTSTRAP.md`).
