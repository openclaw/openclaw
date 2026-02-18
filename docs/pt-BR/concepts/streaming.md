---
summary: "Comportamento de Streaming + chunking (block replies, preview streaming Telegram, limites)"
read_when:
  - Explicando como streaming ou chunking funciona em canais
  - Mudando comportamento de block streaming ou chunking de canal
  - Debugando block replies duplicadas/antecipadas ou preview streaming Telegram
title: "Streaming e Chunking"
---

# Streaming + chunking

OpenClaw tem duas camadas de "streaming" separadas:

- **Block streaming (canais):** emite **blocos** completos conforme o assistente escreve. Estes são mensagens de canal normais (não deltas de token).
- **Token-ish streaming (apenas Telegram):** atualiza uma **mensagem de preview** temporária com texto parcial enquanto gera.

Não existe **streaming verdadeiro de delta de token** para mensagens de canal hoje. Preview streaming do Telegram é a única superfície de partial-stream.

## Block streaming (mensagens de canal)

Block streaming envia saída do assistente em chunks grossos conforme ficam disponíveis.

```
Saída do modelo
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emite blocos conforme buffer cresce
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes em message_end
                   └─ channel send (block replies)
```

Legenda:

- `text_delta/events`: eventos de stream do modelo (podem ser sparse para modelos não-streaming).
- `chunker`: `EmbeddedBlockChunker` aplicando limites min/max + preferência de break.
- `channel send`: mensagens outbound reais (block replies).

**Controles:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (padrão off).
- Substituições de canal: `*.blockStreaming` (e variantes por conta) para forçar `"on"`/`"off"` por canal.
- `agents.defaults.blockStreamingBreak`: `"text_end"` ou `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (mescla blocos streamed antes de enviar).
- Cap rígido de canal: `*.textChunkLimit` (por ex., `channels.whatsapp.textChunkLimit`).
- Modo chunk de canal: `*.chunkMode` (`length` padrão, `newline` divide em linhas em branco (limites de parágrafo) antes de chunking de comprimento).
- Cap suave Discord: `channels.discord.maxLinesPerMessage` (padrão 17) divide replies altas para evitar clipping de UI.

**Semântica de limite:**

- `text_end`: faz stream de blocos assim que chunker emite; flushes em cada `text_end`.
- `message_end`: espera até que mensagem do assistente termine, depois flushes saída bufferizada.

`message_end` ainda usa o chunker se o texto bufferizado exceder `maxChars`, então pode emitir múltiplos chunks no final.

## Algoritmo de chunking (limites baixo/alto)

Block chunking é implementado por `EmbeddedBlockChunker`:

- **Limite baixo:** não emite até buffer >= `minChars` (a menos que forçado).
- **Limite alto:** prefere splits antes de `maxChars`; se forçado, split em `maxChars`.
- **Preferência de break:** `paragraph` → `newline` → `sentence` → `whitespace` → hard break.
- **Code fences:** nunca divide dentro de fences; quando forçado em `maxChars`, fecha + reabre a fence para manter Markdown válido.

`maxChars` é clamped para o canal `textChunkLimit`, então você não pode exceder caps por canal.

## Coalescing (mescla blocos streamed)

Quando block streaming está habilitado, OpenClaw pode **mesclar chunks de bloco consecutivos** antes de enviá-los. Isso reduz "single-line spam" enquanto ainda fornece saída progressiva.

- Coalescing espera por **idle gaps** (`idleMs`) antes de flushes.
- Buffers são capped por `maxChars` e flushes se excederem.
- `minChars` previne fragmentos minúsculos de enviar até texto suficiente acumular (final flush sempre envia texto restante).
- Joiner é derivado de `blockStreamingChunk.breakPreference` (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → space).
- Substituições de canal estão disponíveis via `*.blockStreamingCoalesce` (incluindo configs por conta).
- Padrão coalesce `minChars` é bumped para 1500 para Signal/Slack/Discord a menos que sobrescrito.

## Pacing humano entre blocos

Quando block streaming está habilitado, você pode adicionar uma **pausa aleatorizada** entre block replies (após o primeiro bloco). Isso faz respostas multi-bubble parecerem mais naturais.

- Config: `agents.defaults.humanDelay` (sobrescrever por agente via `agents.list[].humanDelay`).
- Modos: `off` (padrão), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`).
- Se aplica apenas a **block replies**, não respostas finais ou resumos de ferramenta.

## "Stream chunks ou tudo"

Isto mapeia para:

- **Stream chunks:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (emite conforme vai). Canais não-Telegram também precisam de `*.blockStreaming: true`.
- **Stream tudo no final:** `blockStreamingBreak: "message_end"` (flushes uma vez, possivelmente múltiplos chunks se muito longo).
- **Sem block streaming:** `blockStreamingDefault: "off"` (apenas resposta final).

**Nota de canal:** Para canais não-Telegram, block streaming está **desabilitado a menos que** `*.blockStreaming` seja explicitamente definido como `true`. Telegram pode fazer stream de uma preview ao vivo (`channels.telegram.streamMode`) sem block replies.

Lembrete de localização de config: os padrões `blockStreaming*` vivem sob `agents.defaults`, não a config raiz.

## Telegram preview streaming (token-ish)

Telegram é o único canal com live preview streaming:

- Usa Bot API `sendMessage` (primeira atualização) + `editMessageText` (atualizações subsequentes).
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: preview atualiza com o texto de stream mais recente.
  - `block`: preview atualiza em blocos chunked (mesmas regras de chunker).
  - `off`: sem preview streaming.
- Config de chunk de preview (apenas para `streamMode: "block"`): `channels.telegram.draftChunk` (padrões: `minChars: 200`, `maxChars: 800`).
- Preview streaming é separado de block streaming.
- Quando Telegram block streaming está explicitamente habilitado, preview streaming é ignorado para evitar double-streaming.
- Finais text-only são aplicados editando a mensagem de preview in place.
- Finais non-text/complex caem de volta para normal de delivery de mensagem final.
- `/reasoning stream` escreve raciocínio na preview ao vivo (apenas Telegram).

```
Telegram
  └─ sendMessage (mensagem de preview temporária)
       ├─ streamMode=partial → edita texto mais recente
       └─ streamMode=block   → chunker + edita atualizações
  └─ resposta final text-only → edit final na mesma mensagem
  └─ fallback: cleanup preview + normal final delivery (media/complex)
```

Legenda:

- `preview message`: mensagem Telegram temporária atualizada durante geração.
- `final edit`: edição in-place na mesma mensagem de preview (text-only).
