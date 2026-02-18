---
summary: "Design de fila de comando que serializa execuções de auto-reply de entrada"
read_when:
  - Mudando execução ou concorrência de auto-reply
title: "Fila de Comando"
---

# Fila de Comando (2026-01-16)

Nós serializamos execuções de auto-reply de entrada (todos os canais) através de uma pequena fila no processo para evitar que múltiplas execuções de agente colidam, enquanto ainda permitimos paralelismo seguro entre sessões.

## Por que

- Execuções de auto-reply podem ser caras (chamadas LLM) e podem colidir quando múltiplas mensagens de entrada chegam perto uma da outra.
- Serializar evita competição por recursos compartilhados (arquivos de sessão, logs, CLI stdin) e reduz a chance de limites de taxa upstream.

## Como funciona

- Uma fila FIFO com conhecimento de pista drena cada pista com um cap de concorrência configurável (padrão 1 para pistas não configuradas; main padrão para 4, subagente para 8).
- `runEmbeddedPiAgent` enfileira por **chave de sessão** (pista `session:<key>`) para garantir apenas uma execução ativa por sessão.
- Cada execução de sessão é então enfileirada na **pista global** (`main` por padrão) para que o paralelismo geral seja capped por `agents.defaults.maxConcurrent`.
- Quando logging verbose está habilitado, execuções enfileiradas emitem um aviso curto se esperaram mais de ~2s antes de iniciar.
- Indicadores de digitação ainda disparam imediatamente em enfileiramento (quando suportado pelo canal) para que a experiência do usuário não mude enquanto esperamos nossa vez.

## Modos de fila (por canal)

Mensagens de entrada podem direcionar a execução atual, esperar por uma volta de followup, ou fazer ambas:

- `steer`: injeta imediatamente na execução atual (cancela chamadas de ferramenta pendentes após o próximo limite de ferramenta). Se não estiver em stream, volta para followup.
- `followup`: enfileira para a próxima volta de agente após a execução atual terminar.
- `collect`: coalesce todas as mensagens enfileiradas em uma **única** volta de followup (padrão). Se mensagens visam diferentes canais/threads, elas drenam individualmente para preservar roteamento.
- `steer-backlog` (aka `steer+backlog`): direciona agora **e** preserva a mensagem para uma volta de followup.
- `interrupt` (legado): aborta a execução ativa para aquela sessão, então executa a mensagem mais nova.
- `queue` (alias legado): o mesmo que `steer`.

Steer-backlog significa você pode obter uma resposta de followup após a execução direcionada, então superfícies de streaming podem parecer duplicatas. Prefira `collect`/`steer` se você quer uma resposta por mensagem de entrada.
Envie `/queue collect` como um comando autônomo (por sessão) ou defina `messages.queue.byChannel.discord: "collect"`.

Padrões (quando não configurados):

- Todas as superfícies → `collect`

Configure globalmente ou por canal via `messages.queue`:

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Opções de fila

Opções se aplicam a `followup`, `collect` e `steer-backlog` (e a `steer` quando volta para followup):

- `debounceMs`: espera por silence antes de iniciar uma volta de followup (previne "continue, continue").
- `cap`: máximo de mensagens enfileiradas por sessão.
- `drop`: política de overflow (`old`, `new`, `summarize`).

Summarize mantém uma lista curta de notas de mensagens descartadas e injeta como um prompt de followup sintético.
Padrões: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Substituições por sessão

- Envie `/queue <mode>` como um comando autônomo para armazenar o modo para a sessão atual.
- Opções podem ser combinadas: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` ou `/queue reset` limpa a substituição de sessão.

## Escopo e garantias

- Se aplica a execuções de auto-reply de agente em todos os canais de entrada que usam o pipeline de reply do gateway (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, etc.).
- Pista padrão (`main`) é process-wide para entrada + heartbeats principais; defina `agents.defaults.maxConcurrent` para permitir múltiplas sessões em paralelo.
- Pistas adicionais podem existir (por ex. `cron`, `subagent`) para que jobs de background possam executar em paralelo sem bloquear replies de entrada.
- Pistas por sessão garantem que apenas uma execução de agente toca uma dada sessão por vez.
- Sem dependências externas ou threads de worker de background; pure TypeScript + promises.

## Troubleshooting

- Se comandos parecem travados, habilite logs verbose e procure por linhas "queued for …ms" para confirmar que a fila está drenando.
- Se você precisa de profundidade de fila, habilite logs verbose e observe linhas de timing de fila.
