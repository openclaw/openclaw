---
summary: "Orientações para escolher entre heartbeat e jobs cron para automação"
read_when:
  - Decidindo como agendar tarefas recorrentes
  - Configurando monitoramento em segundo plano ou notificações
  - Otimizando o uso de tokens para verificações periódicas
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat: Quando usar cada um

Tanto heartbeats quanto jobs cron permitem executar tarefas em um agendamento. Este guia ajuda voce a escolher o mecanismo certo para o seu caso de uso.

## Guia rápido de decisão

| Caso de uso                                      | Recomendado                            | Por quê                                            |
| ------------------------------------------------ | -------------------------------------- | -------------------------------------------------- |
| Verificar inbox a cada 30 min                    | Heartbeat                              | Agrupa com outras verificações, ciente de contexto |
| Enviar relatório diário às 9h em ponto           | Cron (isolado)      | Necessita de horário exato                         |
| Monitorar calendário para eventos próximos       | Heartbeat                              | Encaixe natural para consciência periódica         |
| Executar análise profunda semanal                | Cron (isolado)      | Tarefa independente, pode usar modelo diferente    |
| Lembrar em 20 minutos                            | Cron (main, `--at`) | Execução única com temporização precisa            |
| Verificação de saúde do projeto em segundo plano | Heartbeat                              | Aproveita o ciclo existente                        |

## Heartbeat: Consciência periódica

Heartbeats são executados na **sessão principal** em um intervalo regular (padrão: 30 min). Eles foram projetados para o agente verificar as coisas e destacar o que for importante.

### Quando usar heartbeat

- **Múltiplas verificações periódicas**: Em vez de 5 jobs cron separados verificando inbox, calendário, clima, notificações e status do projeto, um único heartbeat pode agrupar tudo isso.
- **Decisões cientes de contexto**: O agente tem todo o contexto da sessão principal, então pode tomar decisões inteligentes sobre o que é urgente vs. o que pode esperar.
- **Continuidade conversacional**: Execuções de heartbeat compartilham a mesma sessão, então o agente se lembra de conversas recentes e pode dar seguimento de forma natural.
- **Monitoramento de baixo overhead**: Um heartbeat substitui muitas pequenas tarefas de polling.

### Vantagens do heartbeat

- **Agrupa múltiplas verificações**: Um turno do agente pode revisar inbox, calendário e notificações juntos.
- **Reduz chamadas de API**: Um único heartbeat é mais barato do que 5 jobs cron isolados.
- **Ciente de contexto**: O agente sabe no que voce tem trabalhado e pode priorizar de acordo.
- **Supressão inteligente**: Se nada exigir atenção, o agente responde `HEARTBEAT_OK` e nenhuma mensagem é entregue.
- **Temporização natural**: Sofre leve deriva com base na carga da fila, o que é aceitável para a maioria dos monitoramentos.

### Exemplo de heartbeat: checklist do HEARTBEAT.md

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

O agente lê isso a cada heartbeat e trata todos os itens em um único turno.

### Configurando heartbeat

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

Veja [Heartbeat](/gateway/heartbeat) para a configuração completa.

## Cron: Agendamento preciso

Jobs cron são executados em **horários exatos** e podem rodar em sessões isoladas sem afetar o contexto principal.

### Quando usar cron

- **Horário exato obrigatório**: "Envie isso às 9:00 toda segunda-feira" (não "por volta das 9").
- **Tarefas independentes**: Tarefas que não precisam de contexto conversacional.
- **Modelo/pensamento diferente**: Análises pesadas que justificam um modelo mais poderoso.
- **Lembretes de execução única**: "Lembre-me em 20 minutos" com `--at`.
- **Tarefas ruidosas/frequentes**: Tarefas que poluiriam o histórico da sessão principal.
- **Gatilhos externos**: Tarefas que devem rodar independentemente de o agente estar ativo.

### Vantagens do cron

- **Horário exato**: Expressões cron de 5 campos com suporte a fuso horário.
- **Isolamento de sessão**: Executa em `cron:<jobId>` sem poluir o histórico principal.
- **Sobrescritas de modelo**: Use um modelo mais barato ou mais poderoso por job.
- **Controle de entrega**: Jobs isolados usam por padrão `announce` (resumo); escolha `none` conforme necessário.
- **Entrega imediata**: O modo de anúncio publica diretamente sem esperar o heartbeat.
- **Sem contexto do agente**: Executa mesmo se a sessão principal estiver ociosa ou compactada.
- **Suporte a execução única**: `--at` para timestamps futuros precisos.

### Exemplo de cron: briefing matinal diário

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Isso roda exatamente às 7:00 da manhã no horário de Nova York, usa Opus para qualidade e anuncia um resumo diretamente no WhatsApp.

### Exemplo de cron: lembrete de execução única

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

Veja [Cron jobs](/automation/cron-jobs) para a referência completa da CLI.

## Fluxograma de decisão

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## Combinando ambos

A configuração mais eficiente usa **ambos**:

1. **Heartbeat** cuida do monitoramento de rotina (inbox, calendário, notificações) em um único turno em lote a cada 30 minutos.
2. **Cron** cuida de agendas precisas (relatórios diários, revisões semanais) e lembretes de execução única.

### Exemplo: configuração de automação eficiente

**HEARTBEAT.md** (verificado a cada 30 min):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Jobs cron** (temporização precisa):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: fluxos de trabalho determinísticos com aprovações

Lobster é o runtime de workflow para **pipelines de ferramentas em múltiplas etapas** que precisam de execução determinística e aprovações explícitas.
Use quando a tarefa é mais do que um único turno do agente e voce quer um workflow retomável com checkpoints humanos.

### Quando o Lobster se encaixa

- **Automação em múltiplas etapas**: Voce precisa de um pipeline fixo de chamadas de ferramentas, não de um prompt pontual.
- **Portões de aprovação**: Efeitos colaterais devem pausar até voce aprovar e então retomar.
- **Execuções retomáveis**: Continuar um workflow pausado sem reexecutar etapas anteriores.

### Como ele se integra com heartbeat e cron

- **Heartbeat/cron** decidem _quando_ uma execução acontece.
- **Lobster** define _quais etapas_ acontecem quando a execução começa.

Para workflows agendados, use cron ou heartbeat para acionar um turno do agente que chama o Lobster.
Para workflows ad-hoc, chame o Lobster diretamente.

### Notas operacionais (do código)

- O Lobster roda como um **subprocesso local** (CLI `lobster`) em modo de ferramenta e retorna um **envelope JSON**.
- Se a ferramenta retornar `needs_approval`, voce retoma com um `resumeToken` e a flag `approve`.
- A ferramenta é um **plugin opcional**; habilite-a de forma aditiva via `tools.alsoAllow: ["lobster"]` (recomendado).
- Se voce passar `lobsterPath`, ele deve ser um **caminho absoluto**.

Veja [Lobster](/tools/lobster) para uso completo e exemplos.

## Sessão principal vs Sessão isolada

Tanto heartbeat quanto cron podem interagir com a sessão principal, mas de maneiras diferentes:

|           | Heartbeat                      | Cron (main)                       | Cron (isolado)           |
| --------- | ------------------------------ | ---------------------------------------------------- | ------------------------------------------- |
| Sessão    | Principal                      | Principal (via evento do sistema) | `cron:<jobId>`                              |
| Histórico | Compartilhado                  | Compartilhado                                        | Novo a cada execução                        |
| Contexto  | Completo                       | Completo                                             | Nenhum (começa limpo)    |
| Modelo    | Modelo da sessão principal     | Modelo da sessão principal                           | Pode sobrescrever                           |
| Saída     | Entregue se não `HEARTBEAT_OK` | Prompt do heartbeat + evento                         | Anunciar resumo (padrão) |

### Quando usar cron na sessão principal

Use `--session main` com `--system-event` quando voce quiser:

- Que o lembrete/evento apareça no contexto da sessão principal
- Que o agente lide com isso durante o próximo heartbeat com contexto completo
- Nenhuma execução isolada separada

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### Quando usar cron isolado

Use `--session isolated` quando voce quiser:

- Um estado limpo sem contexto prévio
- Configurações diferentes de modelo ou pensamento
- Anunciar resumos diretamente para um canal
- Histórico que não polui a sessão principal

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## Considerações de custo

| Mecanismo                         | Perfil de custo                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------- |
| Heartbeat                         | Um turno a cada N minutos; escala com o tamanho do HEARTBEAT.md |
| Cron (main)    | Adiciona evento ao próximo heartbeat (sem turno isolado)     |
| Cron (isolado) | Turno completo do agente por job; pode usar modelo mais barato                  |

**Dicas**:

- Mantenha `HEARTBEAT.md` pequeno para minimizar overhead de tokens.
- Agrupe verificações semelhantes no heartbeat em vez de múltiplos jobs cron.
- Use `target: "none"` no heartbeat se voce quiser apenas processamento interno.
- Use cron isolado com um modelo mais barato para tarefas rotineiras.

## Relacionados

- [Heartbeat](/gateway/heartbeat) - configuração completa de heartbeat
- [Cron jobs](/automation/cron-jobs) - referência completa da CLI e API de cron
- [System](/cli/system) - eventos do sistema + controles de heartbeat
