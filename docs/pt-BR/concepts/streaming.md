---
summary: "Comportamento de streaming + chunking (respostas em blocos, streaming de rascunho, limites)"
read_when:
  - Explicando como o streaming ou chunking funciona nos canais
  - Alterando o streaming em blocos ou o comportamento de chunking do canal
  - Depurando respostas em bloco duplicadas/antecipadas ou streaming de rascunho
title: "Streaming e Chunking"
---

# Streaming + chunking

O OpenClaw tem duas camadas separadas de “streaming”:

- **Streaming em blocos (canais):** emite **blocos** concluídos conforme o assistente escreve. São mensagens normais do canal (não deltas de tokens).
- **Streaming tipo token (apenas Telegram):** atualiza uma **bolha de rascunho** com texto parcial enquanto gera; a mensagem final é enviada ao final.

Não há **streaming real de tokens** para mensagens externas de canais hoje. O streaming de rascunho do Telegram é a única superfície de streaming parcial.

## Streaming em blocos (mensagens do canal)

O streaming em blocos envia a saída do assistente em chunks grosseiros conforme ficam disponíveis.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legenda:

- `text_delta/events`: eventos de stream do modelo (podem ser esparsos para modelos sem streaming).
- `chunker`: `EmbeddedBlockChunker` aplicando limites mínimo/máximo + preferência de quebra.
- `channel send`: mensagens de saída reais (respostas em blocos).

**Controles:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (desativado por padrão).
- Substituições por canal: `*.blockStreaming` (e variantes por conta) para forçar `"on"`/`"off"` por canal.
- `agents.defaults.blockStreamingBreak`: `"text_end"` ou `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (mesclar blocos transmitidos antes do envio).
- Limite rígido do canal: `*.textChunkLimit` (por exemplo, `channels.whatsapp.textChunkLimit`).
- Modo de chunking do canal: `*.chunkMode` (`length` padrão, `newline` divide em linhas em branco (limites de parágrafo) antes do chunking por comprimento).
- Limite flexível do Discord: `channels.discord.maxLinesPerMessage` (padrão 17) divide respostas altas para evitar recorte na UI.

**Semântica de limites:**

- `text_end`: transmite blocos assim que o chunker emite; descarrega a cada `text_end`.
- `message_end`: aguarda até a mensagem do assistente terminar e então descarrega a saída em buffer.

`message_end` ainda usa o chunker se o texto em buffer exceder `maxChars`, então pode emitir múltiplos chunks ao final.

## Algoritmo de chunking (limites baixo/alto)

O chunking de blocos é implementado por `EmbeddedBlockChunker`:

- **Limite baixo:** não emitir até o buffer >= `minChars` (a menos que forçado).
- **Limite alto:** preferir quebras antes de `maxChars`; se forçado, dividir em `maxChars`.
- **Preferência de quebra:** `paragraph` → `newline` → `sentence` → `whitespace` → quebra rígida.
- **Cercas de código:** nunca dividir dentro de cercas; quando forçado em `maxChars`, fechar + reabrir a cerca para manter o Markdown válido.

`maxChars` é limitado ao `textChunkLimit` do canal, então você não pode exceder os limites por canal.

## Coalescência (mesclar blocos transmitidos)

Quando o streaming em blocos está ativado, o OpenClaw pode **mesclar chunks de blocos consecutivos**
antes de enviá-los. Isso reduz “spam de linha única” enquanto ainda fornece
saída progressiva.

- A coalescência aguarda **intervalos ociosos** (`idleMs`) antes de descarregar.
- Os buffers são limitados por `maxChars` e serão descarregados se excederem isso.
- `minChars` impede o envio de fragmentos minúsculos até que texto suficiente se acumule
  (a descarga final sempre envia o texto restante).
- O conector é derivado de `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → espaço).
- Substituições por canal estão disponíveis via `*.blockStreamingCoalesce` (incluindo configurações por conta).
- O `minChars` de coalescência padrão é aumentado para 1500 para Signal/Slack/Discord, a menos que seja substituído.

## Ritmo humano entre blocos

Quando o streaming em blocos está ativado, você pode adicionar uma **pausa aleatória**
entre respostas em bloco (após o primeiro bloco). Isso faz respostas com múltiplas bolhas parecerem
mais naturais.

- Configuração: `agents.defaults.humanDelay` (substituir por agente via `agents.list[].humanDelay`).
- Modos: `off` (padrão), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`).
- Aplica-se apenas a **respostas em bloco**, não a respostas finais ou resumos de ferramentas.

## “Transmitir chunks ou tudo”

Isso mapeia para:

- **Transmitir chunks:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (emitir conforme avança). Canais não Telegram também precisam de `*.blockStreaming: true`.
- **Transmitir tudo no final:** `blockStreamingBreak: "message_end"` (descarregar uma vez, possivelmente em múltiplos chunks se for muito longo).
- **Sem streaming em blocos:** `blockStreamingDefault: "off"` (apenas resposta final).

**Nota do canal:** Para canais não Telegram, o streaming em blocos fica **desativado a menos que**
`*.blockStreaming` seja explicitamente definido como `true`. O Telegram pode transmitir rascunhos
(`channels.telegram.streamMode`) sem respostas em bloco.

Lembrete de local da configuração: os padrões de `blockStreaming*` ficam em
`agents.defaults`, não na configuração raiz.

## Streaming de rascunho do Telegram (tipo token)

O Telegram é o único canal com streaming de rascunho:

- Usa a API de Bot `sendMessageDraft` em **chats privados com tópicos**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: atualizações do rascunho com o texto de stream mais recente.
  - `block`: atualizações do rascunho em blocos chunked (mesmas regras do chunker).
  - `off`: sem streaming de rascunho.
- Configuração de chunk do rascunho (apenas para `streamMode: "block"`): `channels.telegram.draftChunk` (padrões: `minChars: 200`, `maxChars: 800`).
- O streaming de rascunho é separado do streaming em blocos; respostas em bloco ficam desativadas por padrão e só são ativadas por `*.blockStreaming: true` em canais não Telegram.
- A resposta final ainda é uma mensagem normal.
- `/reasoning stream` grava o raciocínio na bolha de rascunho (apenas Telegram).

Quando o streaming de rascunho está ativo, o OpenClaw desativa o streaming em blocos para aquela resposta para evitar streaming duplo.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Legenda:

- `sendMessageDraft`: bolha de rascunho do Telegram (não é uma mensagem real).
- `final reply`: envio normal de mensagem do Telegram.
