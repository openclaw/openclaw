---
summary: "Daloy ng mensahe, mga session, queueing, at visibility ng reasoning"
read_when:
  - Pagpapaliwanag kung paano nagiging mga reply ang mga inbound na mensahe
  - Paglilinaw ng mga session, queueing mode, o gawi ng streaming
  - Pagdodokumento ng visibility ng reasoning at mga implikasyon sa paggamit
title: "Mga Mensahe"
x-i18n:
  source_path: concepts/messages.md
  source_hash: 773301d5c0c1e3b8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:27Z
---

# Mga Mensahe

Pinagdurugtong ng pahinang ito kung paano hinahawakan ng OpenClaw ang mga inbound na mensahe, mga session, queueing,
streaming, at visibility ng reasoning.

## Daloy ng mensahe (high level)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Nasa configuration ang mga pangunahing control:

- `messages.*` para sa mga prefix, queueing, at gawi sa group.
- `agents.defaults.*` para sa block streaming at mga default ng chunking.
- Mga override sa channel (`channels.whatsapp.*`, `channels.telegram.*`, atbp.) para sa caps at mga toggle ng streaming.

Tingnan ang [Configuration](/gateway/configuration) para sa kumpletong schema.

## Inbound dedupe

Maaaring muling magpadala ang mga channel ng parehong mensahe pagkatapos ng mga reconnect. Pinananatili ng OpenClaw ang isang
short-lived cache na naka-key sa channel/account/peer/session/message id upang hindi mag-trigger ng panibagong agent run ang mga duplicate na delivery.

## Inbound debouncing

Ang mabilis na sunod-sunod na mga mensahe mula sa **parehong sender** ay maaaring i-batch sa isang agent turn sa pamamagitan ng `messages.inbound`. Ang debouncing ay scoped per channel + conversation
at ginagamit ang pinakahuling mensahe para sa reply threading/IDs.

Config (global default + per-channel overrides):

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

Mga tala:

- Nalalapat ang debounce sa **text-only** na mga mensahe; ang media/attachments ay agad na nagfa-flush.
- Nilalampasan ng mga control command ang debouncing upang manatiling standalone ang mga ito.

## Mga session at device

Ang mga session ay pag-aari ng Gateway, hindi ng mga client.

- Ang mga direct chat ay pinagsasama sa pangunahing session key ng agent.
- Ang mga group/channel ay may kani-kaniyang session key.
- Ang session store at mga transcript ay nasa host ng Gateway.

Maaaring mag-map ang maraming device/channel sa iisang session, ngunit hindi ganap na naka-sync pabalik sa bawat client ang history. Rekomendasyon: gumamit ng isang primary device para sa mahahabang pag-uusap upang maiwasan ang divergent na context. Ang Control UI at TUI ay palaging nagpapakita ng transcript ng session na naka-back sa Gateway, kaya sila ang source of truth.

Mga detalye: [Session management](/concepts/session).

## Mga inbound body at history context

Ipinaghihiwalay ng OpenClaw ang **prompt body** mula sa **command body**:

- `Body`: prompt text na ipinapadala sa agent. Maaaring kabilang dito ang mga channel envelope at
  mga opsyonal na history wrapper.
- `CommandBody`: raw na text ng user para sa pag-parse ng directive/command.
- `RawBody`: legacy alias para sa `CommandBody` (pinananatili para sa compatibility).

Kapag nagbibigay ang isang channel ng history, gumagamit ito ng shared wrapper:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

Para sa **non-direct chats** (mga group/channel/room), ang **kasalukuyang message body** ay nilalagyan ng prefix na
label ng sender (kaparehong estilo na ginagamit para sa mga entry sa history). Pinapanatili nitong pare-pareho ang
real-time at queued/history na mga mensahe sa agent prompt.

Ang mga history buffer ay **pending-only**: kasama rito ang mga mensahe sa group na _hindi_
nag-trigger ng run (halimbawa, mga mention-gated na mensahe) at **hindi kasama** ang mga mensaheng
nasa session transcript na.

Ang pag-strip ng directive ay nalalapat lamang sa seksyon ng **kasalukuyang mensahe** upang manatiling buo ang history.
Ang mga channel na nagra-wrap ng history ay dapat mag-set ng `CommandBody` (o
`RawBody`) sa orihinal na text ng mensahe at panatilihin ang `Body` bilang pinagsamang prompt.
Ang mga history buffer ay nako-configure sa pamamagitan ng `messages.groupChat.historyLimit` (global
default) at mga per-channel override gaya ng `channels.slack.historyLimit` o
`channels.telegram.accounts.<id>.historyLimit` (i-set ang `0` upang i-disable).

## Queueing at mga followup

Kung may aktibong run na, maaaring i-queue ang mga inbound na mensahe, idirekta papasok sa
kasalukuyang run, o kolektahin para sa isang followup na turn.

- I-configure sa pamamagitan ng `messages.queue` (at `messages.queue.byChannel`).
- Mga mode: `interrupt`, `steer`, `followup`, `collect`, kasama ang mga backlog variant.

Mga detalye: [Queueing](/concepts/queue).

## Streaming, chunking, at batching

Nagpapadala ang block streaming ng mga partial reply habang gumagawa ang model ng mga text block.
Iginagalang ng chunking ang mga text limit ng channel at iniiwasang hatiin ang fenced code.

Mga pangunahing setting:

- `agents.defaults.blockStreamingDefault` (`on|off`, default off)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (idle-based batching)
- `agents.defaults.humanDelay` (human-like na pause sa pagitan ng mga block reply)
- Mga override sa channel: `*.blockStreaming` at `*.blockStreamingCoalesce` (ang mga non-Telegram channel ay nangangailangan ng tahasang `*.blockStreaming: true`)

Mga detalye: [Streaming + chunking](/concepts/streaming).

## Visibility ng reasoning at mga token

Maaaring ilantad o itago ng OpenClaw ang reasoning ng model:

- Kinokontrol ng `/reasoning on|off|stream` ang visibility.
- Ang reasoning content ay binibilang pa rin sa paggamit ng token kapag ginawa ng model.
- Sinusuportahan ng Telegram ang reasoning stream papasok sa draft bubble.

Mga detalye: [Thinking + reasoning directives](/tools/thinking) at [Token use](/reference/token-use).

## Mga prefix, threading, at mga reply

Ang pag-format ng outbound na mensahe ay sentralisado sa `messages`:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix`, at `channels.<channel>.accounts.<id>.responsePrefix` (outbound prefix cascade), kasama ang `channels.whatsapp.messagePrefix` (WhatsApp inbound prefix)
- Reply threading sa pamamagitan ng `replyToMode` at mga per-channel default

Mga detalye: [Configuration](/gateway/configuration#messages) at mga docs ng channel.
