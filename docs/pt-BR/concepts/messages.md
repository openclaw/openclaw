---
summary: "Fluxo de mensagens, sessões, enfileiramento e visibilidade do raciocínio"
read_when:
  - Explicar como mensagens de entrada se tornam respostas
  - Esclarecer sessões, modos de enfileiramento ou comportamento de streaming
  - Documentar visibilidade do raciocínio e implicações de uso
title: "Mensagens"
---

# Mensagens

Esta página reúne como o OpenClaw lida com mensagens de entrada, sessões, enfileiramento,
streaming e visibilidade do raciocínio.

## Fluxo de mensagens (visão geral)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Principais ajustes ficam na configuração:

- `messages.*` para prefixos, enfileiramento e comportamento em grupos.
- `agents.defaults.*` para streaming em blocos e padrões de fragmentação.
- Substituições por canal (`channels.whatsapp.*`, `channels.telegram.*`, etc.) para limites e alternâncias de streaming.

Veja [Configuração](/gateway/configuration) para o esquema completo.

## Deduplicação de entrada

Canais podem reenviar a mesma mensagem após reconexões. O OpenClaw mantém um
cache de curta duração com chave por canal/conta/par/sessão/id da mensagem para que
entregas duplicadas não acionem outra execução do agente.

## Debouncing de entrada

Mensagens rápidas e consecutivas do **mesmo remetente** podem ser agrupadas em um
único turno do agente via `messages.inbound`. O debouncing é delimitado por canal + conversa
e usa a mensagem mais recente para encadeamento/IDs de resposta.

Configuração (padrão global + substituições por canal):

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Notas:

- O debounce se aplica a mensagens **somente de texto**; mídia/anexos são enviados imediatamente.
- Comandos de controle ignoram o debounce para permanecerem independentes.

## Sessões e dispositivos

As sessões pertencem ao gateway, não aos clientes.

- Conversas diretas colapsam na chave principal de sessão do agente.
- Grupos/canais recebem suas próprias chaves de sessão.
- O armazenamento de sessões e as transcrições ficam no host do Gateway.

Vários dispositivos/canais podem mapear para a mesma sessão, mas o histórico não é
totalmente sincronizado de volta para todos os clientes. Recomendação: use um dispositivo
principal para conversas longas para evitar contexto divergente. A UI de Controle e a TUI
sempre exibem a transcrição da sessão mantida pelo gateway, portanto são a fonte de verdade.

Detalhes: [Gerenciamento de sessões](/concepts/session).

## Corpos de entrada e contexto de histórico

O OpenClaw separa o **corpo do prompt** do **corpo do comando**:

- `Body`: texto do prompt enviado ao agente. Pode incluir envelopes do canal e
  wrappers opcionais de histórico.
- `CommandBody`: texto bruto do usuário para análise de diretivas/comandos.
- `RawBody`: alias legado para `CommandBody` (mantido por compatibilidade).

Quando um canal fornece histórico, ele usa um wrapper compartilhado:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

Para **chats não diretos** (grupos/canais/salas), o **corpo da mensagem atual** recebe um prefixo com o
rótulo do remetente (mesmo estilo usado para entradas de histórico). Isso mantém consistentes as
mensagens em tempo real e as enfileiradas/de histórico no prompt do agente.

Os buffers de histórico são **somente pendentes**: incluem mensagens de grupo que **não**
acionaram uma execução (por exemplo, mensagens com gatilho por menção) e **excluem** mensagens
já presentes na transcrição da sessão.

A remoção de diretivas se aplica apenas à seção da **mensagem atual**, para que o histórico
permaneça intacto. Canais que encapsulam histórico devem definir `CommandBody` (ou
`RawBody`) com o texto original da mensagem e manter `Body` como o prompt combinado.
Os buffers de histórico são configuráveis via `messages.groupChat.historyLimit` (padrão global) e substituições
por canal como `channels.slack.historyLimit` ou `channels.telegram.accounts.<id>.historyLimit` (defina `0` para desativar).

## Enfileiramento e acompanhamentos

Se uma execução já estiver ativa, mensagens de entrada podem ser enfileiradas, direcionadas para a
execução atual ou coletadas para um turno de acompanhamento.

- Configure via `messages.queue` (e `messages.queue.byChannel`).
- Modos: `interrupt`, `steer`, `followup`, `collect`, além de variantes com backlog.

Detalhes: [Enfileiramento](/concepts/queue).

## Streaming, fragmentação e agrupamento

O streaming em blocos envia respostas parciais conforme o modelo produz blocos de texto.
A fragmentação respeita os limites de texto do canal e evita dividir código delimitado.

Principais configurações:

- `agents.defaults.blockStreamingDefault` (`on|off`, desativado por padrão)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (agrupamento baseado em inatividade)
- `agents.defaults.humanDelay` (pausa semelhante à humana entre respostas em blocos)
- Substituições por canal: `*.blockStreaming` e `*.blockStreamingCoalesce` (canais não Telegram exigem `*.blockStreaming: true` explícito)

Detalhes: [Streaming + fragmentação](/concepts/streaming).

## Visibilidade do raciocínio e tokens

O OpenClaw pode expor ou ocultar o raciocínio do modelo:

- `/reasoning on|off|stream` controla a visibilidade.
- O conteúdo de raciocínio ainda conta para o uso de tokens quando produzido pelo modelo.
- O Telegram oferece suporte ao streaming do raciocínio para o balão de rascunho.

Detalhes: [Diretivas de pensamento + raciocínio](/tools/thinking) e [Uso de tokens](/reference/token-use).

## Prefixos, encadeamento e respostas

A formatação de mensagens de saída é centralizada em `messages`:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix` e `channels.<channel>.accounts.<id>.responsePrefix` (cascata de prefixos de saída), além de `channels.whatsapp.messagePrefix` (prefixo de entrada do WhatsApp)
- Encadeamento de respostas via `replyToMode` e padrões por canal

Detalhes: [Configuração](/gateway/configuration#messages) e documentação dos canais.
