---
summary: "Cron jobs + wakeups para o scheduler do Gateway"
read_when:
  - Agendamento de jobs em segundo plano ou wakeups
  - Conectar automações que devem rodar com ou junto aos heartbeats
  - Decidir entre heartbeat e cron para tarefas agendadas
title: "Cron Jobs"
---

# Cron jobs (scheduler do Gateway)

> **Cron vs Heartbeat?** Veja [Cron vs Heartbeat](/automation/cron-vs-heartbeat) para orientações sobre quando usar cada um.

Cron é o scheduler integrado do Gateway. Ele persiste jobs, acorda o agente no
momento certo e pode, opcionalmente, entregar a saída de volta a um chat.

Se você quer _“executar isso toda manhã”_ ou _“cutucar o agente em 20 minutos”_,
cron é o mecanismo.

Solução de problemas: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron roda **dentro do Gateway** (não dentro do modelo).
- Jobs persistem em `~/.openclaw/cron/` para que reinícios não percam agendas.
- Dois estilos de execução:
  - **Sessão principal**: enfileira um evento de sistema e executa no próximo heartbeat.
  - **Isolado**: executa um turno dedicado do agente em `cron:<jobId>`, com entrega (anunciar por padrão ou nenhuma).
- Wakeups são de primeira classe: um job pode solicitar “acordar agora” vs “próximo heartbeat”.

## Início rápido (prático)

Crie um lembrete pontual, verifique que ele existe e execute imediatamente:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

Agende um job isolado recorrente com entrega:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## Equivalentes de tool-call (ferramenta cron do Gateway)

Para os formatos JSON canônicos e exemplos, veja [Esquema JSON para tool calls](/automation/cron-jobs#json-schema-for-tool-calls).

## Onde os cron jobs são armazenados

Cron jobs são persistidos no host do Gateway em `~/.openclaw/cron/jobs.json` por padrão.
O Gateway carrega o arquivo na memória e o grava de volta quando há alterações, então edições manuais
só são seguras quando o Gateway está parado. Prefira `openclaw cron add/edit` ou a API de tool call
do cron para alterações.

## Visão geral para iniciantes

Pense em um cron job como: **quando** executar + **o que** fazer.

1. **Escolha uma agenda**
   - Lembrete pontual → `schedule.kind = "at"` (CLI: `--at`)
   - Job recorrente → `schedule.kind = "every"` ou `schedule.kind = "cron"`
   - Se seu timestamp ISO omitir fuso horário, ele é tratado como **UTC**.

2. **Escolha onde ele roda**
   - `sessionTarget: "main"` → executa durante o próximo heartbeat com o contexto principal.
   - `sessionTarget: "isolated"` → executa um turno dedicado do agente em `cron:<jobId>`.

3. **Escolha o payload**
   - Sessão principal → `payload.kind = "systemEvent"`
   - Sessão isolada → `payload.kind = "agentTurn"`

Opcional: jobs pontuais (`schedule.kind = "at"`) são excluídos após sucesso por padrão. Defina
`deleteAfterRun: false` para mantê-los (eles serão desativados após o sucesso).

## Conceitos

### Jobs

Um cron job é um registro armazenado com:

- uma **agenda** (quando deve executar),
- um **payload** (o que deve fazer),
- **modo de entrega** opcional (anunciar ou nenhum).
- **vinculação de agente** opcional (`agentId`): executa o job sob um agente específico; se
  ausente ou desconhecido, o gateway recorre ao agente padrão.

Jobs são identificados por um `jobId` estável (usado por CLI/APIs do Gateway).
Em tool calls do agente, `jobId` é canônico; o legado `id` é aceito por compatibilidade.
Jobs pontuais se autoexcluem após sucesso por padrão; defina `deleteAfterRun: false` para mantê-los.

### Agendas

Cron suporta três tipos de agenda:

- `at`: timestamp pontual via `schedule.at` (ISO 8601).
- `every`: intervalo fixo (ms).
- `cron`: expressão cron de 5 campos com fuso horário IANA opcional.

Expressões cron usam `croner`. Se um fuso horário for omitido, o fuso horário local
do host do Gateway é usado.

### Execução principal vs isolada

#### Jobs da sessão principal (eventos de sistema)

Jobs principais enfileiram um evento de sistema e opcionalmente acordam o executor de heartbeat.
Eles devem usar `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (padrão): o evento dispara uma execução imediata de heartbeat.
- `wakeMode: "next-heartbeat"`: o evento aguarda o próximo heartbeat agendado.

Este é o melhor encaixe quando você quer o prompt normal de heartbeat + contexto da sessão principal.
Veja [Heartbeat](/gateway/heartbeat).

#### Jobs isolados (sessões cron dedicadas)

Jobs isolados executam um turno dedicado do agente na sessão `cron:<jobId>`.

Comportamentos-chave:

- O prompt é prefixado com `[cron:<jobId> <job name>]` para rastreabilidade.
- Cada execução inicia um **id de sessão novo** (sem reaproveitar conversa anterior).
- Comportamento padrão: se `delivery` for omitido, jobs isolados anunciam um resumo (`delivery.mode = "announce"`).
- `delivery.mode` (apenas isolado) escolhe o que acontece:
  - `announce`: entrega um resumo ao canal alvo e publica um breve resumo na sessão principal.
  - `none`: apenas interno (sem entrega, sem resumo na sessão principal).
- `wakeMode` controla quando o resumo da sessão principal é publicado:
  - `now`: heartbeat imediato.
  - `next-heartbeat`: aguarda o próximo heartbeat agendado.

Use jobs isolados para tarefas ruidosas, frequentes ou “tarefas de fundo” que não devem
poluir o histórico do chat principal.

### Formatos de payload (o que executa)

Dois tipos de payload são suportados:

- `systemEvent`: apenas sessão principal, roteado pelo prompt de heartbeat.
- `agentTurn`: apenas sessão isolada, executa um turno dedicado do agente.

Campos comuns de `agentTurn`:

- `message`: prompt de texto obrigatório.
- `model` / `thinking`: substituições opcionais (veja abaixo).
- `timeoutSeconds`: substituição opcional de timeout.

Configuração de entrega (apenas jobs isolados):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` ou um canal específico.
- `delivery.to`: alvo específico do canal (telefone/chat/id do canal).
- `delivery.bestEffort`: evita falhar o job se a entrega de anúncio falhar.

A entrega por anúncio suprime envios via ferramentas de mensagens durante a execução; use `delivery.channel`/`delivery.to`
para direcionar o chat. Quando `delivery.mode = "none"`, nenhum resumo é publicado na sessão principal.

Se `delivery` for omitido para jobs isolados, o OpenClaw usa por padrão `announce`.

#### Fluxo de entrega por anúncio

Quando `delivery.mode = "announce"`, o cron entrega diretamente via adaptadores de canal de saída.
O agente principal não é iniciado para elaborar ou encaminhar a mensagem.

Detalhes de comportamento:

- Conteúdo: a entrega usa os payloads de saída da execução isolada (texto/mídia) com fragmentação normal e
  formatação do canal.
- Respostas apenas de heartbeat (`HEARTBEAT_OK` sem conteúdo real) não são entregues.
- Se a execução isolada já enviou uma mensagem ao mesmo alvo via ferramenta de mensagem, a entrega é
  ignorada para evitar duplicatas.
- Alvos de entrega ausentes ou inválidos falham o job, a menos que `delivery.bestEffort = true`.
- Um resumo curto é publicado na sessão principal somente quando `delivery.mode = "announce"`.
- O resumo da sessão principal respeita `wakeMode`: `now` dispara um heartbeat imediato e
  `next-heartbeat` aguarda o próximo heartbeat agendado.

### Substituições de modelo e thinking

Jobs isolados (`agentTurn`) podem substituir o modelo e o nível de thinking:

- `model`: string de provedor/modelo (ex.: `anthropic/claude-sonnet-4-20250514`) ou alias (ex.: `opus`)
- `thinking`: nível de thinking (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; apenas modelos GPT-5.2 + Codex)

Nota: Você pode definir `model` em jobs da sessão principal também, mas isso altera o modelo compartilhado da
sessão principal. Recomendamos substituições de modelo apenas para jobs isolados para evitar
mudanças inesperadas de contexto.

Prioridade de resolução:

1. Substituição no payload do job (mais alta)
2. Padrões específicos do hook (ex.: `hooks.gmail.model`)
3. Padrão da configuração do agente

### Entrega (canal + alvo)

Jobs isolados podem entregar a saída a um canal via a configuração de nível superior `delivery`:

- `delivery.mode`: `announce` (entregar um resumo) ou `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`.
- `delivery.to`: alvo de destinatário específico do canal.

A configuração de entrega é válida apenas para jobs isolados (`sessionTarget: "isolated"`).

Se `delivery.channel` ou `delivery.to` for omitido, o cron pode recorrer à “última rota” da sessão principal
(o último local onde o agente respondeu).

Lembretes de formato de alvo:

- Alvos de Slack/Discord/Mattermost (plugin) devem usar prefixos explícitos (ex.: `channel:<id>`, `user:<id>`) para evitar ambiguidade.
- Tópicos do Telegram devem usar o formato `:topic:` (veja abaixo).

#### Alvos de entrega do Telegram (tópicos / threads de fórum)

O Telegram suporta tópicos de fórum via `message_thread_id`. Para entrega por cron, você pode codificar
o tópico/thread no campo `to`:

- `-1001234567890` (apenas id do chat)
- `-1001234567890:topic:123` (preferido: marcador explícito de tópico)
- `-1001234567890:123` (atalho: sufixo numérico)

Alvos prefixados como `telegram:...` / `telegram:group:...` também são aceitos:

- `telegram:group:-1001234567890:topic:123`

## Esquema JSON para tool calls

Use estes formatos ao chamar diretamente as ferramentas `cron.*` do Gateway (tool calls do agente ou RPC).
As flags da CLI aceitam durações humanas como `20m`, mas tool calls devem usar uma string ISO 8601
para `schedule.at` e milissegundos para `schedule.everyMs`.

### Parâmetros de cron.add

Job pontual, sessão principal (evento de sistema):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

Job recorrente, isolado com entrega:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

Notas:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), ou `cron` (`expr`, opcional `tz`).
- `schedule.at` aceita ISO 8601 (fuso horário opcional; tratado como UTC quando omitido).
- `everyMs` é em milissegundos.
- `sessionTarget` deve ser `"main"` ou `"isolated"` e deve corresponder a `payload.kind`.
- Campos opcionais: `agentId`, `description`, `enabled`, `deleteAfterRun` (padrão true para `at`),
  `delivery`.
- `wakeMode` usa por padrão `"now"` quando omitido.

### Parâmetros de cron.update

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

Notas:

- `jobId` é canônico; `id` é aceito por compatibilidade.
- Use `agentId: null` no patch para limpar uma vinculação de agente.

### Parâmetros de cron.run e cron.remove

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Armazenamento e histórico

- Armazenamento de jobs: `~/.openclaw/cron/jobs.json` (JSON gerenciado pelo Gateway).
- Histórico de execuções: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, auto-podado).
- Substituir o caminho de armazenamento: `cron.store` na configuração.

## Configuração

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

Desativar o cron completamente:

- `cron.enabled: false` (config)
- `OPENCLAW_SKIP_CRON=1` (env)

## Início rápido da CLI

Lembrete pontual (ISO UTC, autoexclusão após sucesso):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

Lembrete pontual (sessão principal, acordar imediatamente):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Job isolado recorrente (anunciar no WhatsApp):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Job isolado recorrente (entregar a um tópico do Telegram):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

Job isolado com substituição de modelo e thinking:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Seleção de agente (configurações com múltiplos agentes):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Execução manual (forçar é o padrão; use `--due` para executar apenas quando devido):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

Editar um job existente (patch de campos):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Histórico de execuções:

```bash
openclaw cron runs --id <jobId> --limit 50
```

Evento de sistema imediato sem criar um job:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Superfície da API do Gateway

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (forçar ou devido), `cron.runs`
  Para eventos de sistema imediatos sem um job, use [`openclaw system event`](/cli/system).

## Solução de problemas

### “Nada executa”

- Verifique se o cron está habilitado: `cron.enabled` e `OPENCLAW_SKIP_CRON`.
- Verifique se o Gateway está rodando continuamente (o cron roda dentro do processo do Gateway).
- Para agendas `cron`: confirme o fuso horário (`--tz`) vs o fuso do host.

### Um job recorrente continua atrasando após falhas

- O OpenClaw aplica backoff exponencial de retry para jobs recorrentes após erros consecutivos:
  30s, 1m, 5m, 15m, depois 60m entre tentativas.
- O backoff é redefinido automaticamente após a próxima execução bem-sucedida.
- Jobs pontuais (`at`) são desativados após uma execução terminal (`ok`, `error` ou `skipped`) e não fazem retry.

### O Telegram entrega no lugar errado

- Para tópicos de fórum, use `-100…:topic:<id>` para que fique explícito e inequívoco.
- Se você vir prefixos `telegram:...` nos logs ou em alvos de “última rota” armazenados, isso é normal;
  a entrega por cron os aceita e ainda analisa corretamente os IDs de tópico.
