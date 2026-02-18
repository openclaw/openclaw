---
summary: "Fluxo de mensagem, sessões, queueing e visibilidade de raciocínio"
read_when:
  - Explicando como mensagens de entrada se tornam replies
  - Esclarecendo sessões, modos de queueing ou comportamento de streaming
  - Documentando visibilidade de raciocínio e implicações de uso
title: "Mensagens"
---

# Mensagens

Essa página vincula como OpenClaw manipula mensagens de entrada, sessões, queueing, streaming e visibilidade de raciocínio.

## Fluxo de mensagem (alto nível)

```
Mensagem de entrada
  -> routing/bindings -> session key
  -> queue (se uma execução está ativa)
  -> agent run (streaming + tools)
  -> outbound replies (limites de canal + chunking)
```

Knobs-chave vivem em configuração:

- `messages.*` para prefixos, queueing e comportamento de grupo.
- `agents.defaults.*` para padrões block streaming e chunking.
- Substituições de canal (`channels.whatsapp.*`, `channels.telegram.*`, etc.) para caps e toggles de streaming.

Veja [Configuração](/gateway/configuration) para schema completo.

## Dedupe de entrada

Canais podem re-entregar a mesma mensagem após reconexões. OpenClaw mantém um cache de vida curta keyed por channel/account/peer/session/message id para que entregas duplicadas não acionem outra execução de agente.

## Debouncing de entrada

Mensagens rápidas consecutivas do **mesmo remetente** podem ser batidas em uma única volta de agente via `messages.inbound`. Debouncing é scoped per canal + conversa e usa a mensagem mais recente para reply threading/IDs.

Config (padrão global + substituições por canal):

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

- Debounce se aplica a mensagens **text-only**; media/anexos flushes imediatamente.
- Comandos de controle desviam debouncing para que permaneçam autônomos.

## Sessões e dispositivos

Sessões são possuídas pelo gateway, não pelos clientes.

- Chats diretos colapsam na chave de sessão principal do agente.
- Grupos/canais recebem suas próprias chaves de sessão.
- O armazenamento de sessão e transcrições vivem no host do gateway.

Múltiplos dispositivos/canais podem mapear para a mesma sessão, mas histórico não é totalmente sincronizado de volta para cada cliente. Recomendação: use um dispositivo primário para conversas longas para evitar contexto divergente. A Interface de Controle e TUI sempre mostram a transcrição de sessão apoiada por gateway, então são a fonte de verdade.

Detalhes: [Gerenciamento de sessão](/pt-BR/concepts/session).

## Corpos de entrada e contexto de histórico

OpenClaw separa o **prompt body** do **command body**:

- `Body`: texto de prompt enviado ao agente. Isso pode incluir envelopes de canal e wrappers de histórico opcionais.
- `CommandBody`: texto bruto do usuário para parsing de diretiva/comando.
- `RawBody`: alias legado para `CommandBody` (mantido para compatibilidade).

Quando um canal fornece histórico, ele usa um wrapper compartilhado:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

Para **chats não-diretos** (grupos/canais/salas), o **corpo de mensagem atual** é prefixado com o rótulo de remetente (mesmo estilo usado para entradas de histórico). Isso mantém mensagens em tempo real e pendentes/histórico consistentes no prompt do agente.

Buffers de histórico são **pending-only**: eles incluem mensagens de grupo que _não_ foram ainda processadas.
