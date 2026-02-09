---
summary: "Design da fila de comandos que serializa execuções de resposta automática de entrada"
read_when:
  - Alterar a execução ou a concorrência de respostas automáticas
title: "Fila de Comandos"
---

# Fila de Comandos (2026-01-16)

Serializamos execuções de resposta automática de entrada (todos os canais) por meio de uma pequena fila em processo para evitar que múltiplas execuções do agente colidam, mantendo paralelismo seguro entre sessões.

## Por quê

- Execuções de resposta automática podem ser caras (chamadas de LLM) e podem colidir quando várias mensagens de entrada chegam muito próximas no tempo.
- A serialização evita a competição por recursos compartilhados (arquivos de sessão, logs, stdin da CLI) e reduz a chance de limites de taxa upstream.

## Como funciona

- Uma fila FIFO consciente de lanes drena cada lane com um limite de concorrência configurável (padrão 1 para lanes não configuradas; main padrão 4, subagent 8).
- `runEmbeddedPiAgent` enfileira por **chave de sessão** (lane `session:<key>`) para garantir apenas uma execução ativa por sessão.
- Cada execução de sessão é então enfileirada em uma **lane global** (`main` por padrão) para que o paralelismo geral seja limitado por `agents.defaults.maxConcurrent`.
- Quando o logging detalhado está habilitado, execuções enfileiradas emitem um aviso curto se aguardaram mais de ~2s antes de iniciar.
- Indicadores de digitação ainda disparam imediatamente no enfileiramento (quando suportado pelo canal), portanto a experiência do usuário permanece inalterada enquanto aguardamos a vez.

## Modos de fila (por canal)

Mensagens de entrada podem direcionar a execução atual, aguardar um turno de acompanhamento ou fazer ambos:

- `steer`: injeta imediatamente na execução atual (cancela chamadas de ferramentas pendentes após o próximo limite de ferramenta). Se não estiver em streaming, faz fallback para acompanhamento.
- `followup`: enfileira para o próximo turno do agente após o término da execução atual.
- `collect`: agrega todas as mensagens enfileiradas em **um único** turno de acompanhamento (padrão). Se as mensagens tiverem como alvo canais/threads diferentes, elas são drenadas individualmente para preservar o roteamento.
- `steer-backlog` (também conhecido como `steer+backlog`): direciona agora **e** preserva a mensagem para um turno de acompanhamento.
- `interrupt` (legado): aborta a execução ativa para aquela sessão e então executa a mensagem mais recente.
- `queue` (alias legado): igual a `steer`.

Steer-backlog significa que você pode obter uma resposta de acompanhamento após a execução direcionada, portanto
superfícies de streaming podem parecer duplicadas. Prefira `collect`/`steer` se você quiser
uma resposta por mensagem de entrada.
Envie `/queue collect` como um comando independente (por sessão) ou defina `messages.queue.byChannel.discord: "collect"`.

Padrões (quando não definidos na configuração):

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

## Opções da fila

As opções se aplicam a `followup`, `collect` e `steer-backlog` (e a `steer` quando faz fallback para acompanhamento):

- `debounceMs`: aguarda silêncio antes de iniciar um turno de acompanhamento (evita “continuar, continuar”).
- `cap`: máximo de mensagens enfileiradas por sessão.
- `drop`: política de overflow (`old`, `new`, `summarize`).

Summarize mantém uma lista curta em bullets das mensagens descartadas e a injeta como um prompt sintético de acompanhamento.
Padrões: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Substituições por sessão

- Envie `/queue <mode>` como um comando independente para armazenar o modo para a sessão atual.
- As opções podem ser combinadas: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` ou `/queue reset` limpa a substituição da sessão.

## Escopo e garantias

- Aplica-se a execuções de agente de resposta automática em todos os canais de entrada que usam o pipeline de resposta do gateway (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, etc.).
- A lane padrão (`main`) é de todo o processo para entrada + heartbeats principais; defina `agents.defaults.maxConcurrent` para permitir múltiplas sessões em paralelo.
- Lanes adicionais podem existir (por exemplo, `cron`, `subagent`) para que jobs em segundo plano possam rodar em paralelo sem bloquear respostas de entrada.
- Lanes por sessão garantem que apenas uma execução do agente toque uma determinada sessão por vez.
- Sem dependências externas ou threads de worker em segundo plano; TypeScript puro + promises.

## Solução de problemas

- Se os comandos parecerem travados, habilite logs detalhados e procure por linhas “queued for …ms” para confirmar que a fila está drenando.
- Se você precisar da profundidade da fila, habilite logs detalhados e observe as linhas de temporização da fila.
