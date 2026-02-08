---
summary: "Pag-uugali ng streaming + chunking (block replies, draft streaming, mga limitasyon)"
read_when:
  - Ipinapaliwanag kung paano gumagana ang streaming o chunking sa mga channel
  - Binabago ang block streaming o channel chunking behavior
  - Pag-debug ng duplicate/maagang block replies o draft streaming
title: "Streaming at Chunking"
x-i18n:
  source_path: concepts/streaming.md
  source_hash: f014eb1898c4351b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:32Z
---

# Streaming + chunking

May dalawang magkahiwalay na “streaming” layer ang OpenClaw:

- **Block streaming (mga channel):** naglalabas ng mga tapos nang **block** habang nagsusulat ang assistant. Ito ay mga normal na mensahe ng channel (hindi mga token delta).
- **Token-ish streaming (Telegram lamang):** ina-update ang isang **draft bubble** gamit ang bahagyang teksto habang nagge-generate; ang final na mensahe ay ipinapadala sa dulo.

Wala pang **tunay na token streaming** papunta sa mga external na mensahe ng channel sa ngayon. Ang Telegram draft streaming lang ang may partial-stream surface.

## Block streaming (mga mensahe ng channel)

Ang block streaming ay nagpapadala ng output ng assistant sa malalaking tipak habang nagiging available ito.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legend:

- `text_delta/events`: mga event ng model stream (maaaring bihira para sa mga non-streaming na model).
- `chunker`: `EmbeddedBlockChunker` na nag-a-apply ng min/max bounds + break preference.
- `channel send`: aktuwal na outbound messages (block replies).

**Mga kontrol:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (default ay off).
- Mga channel override: `*.blockStreaming` (at mga per-account na variant) para pilitin ang `"on"`/`"off"` kada channel.
- `agents.defaults.blockStreamingBreak`: `"text_end"` o `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (pagsamahin ang mga streamed block bago ipadala).
- Channel hard cap: `*.textChunkLimit` (hal., `channels.whatsapp.textChunkLimit`).
- Channel chunk mode: `*.chunkMode` (`length` default, `newline` naghahati sa mga blank line (hangganan ng talata) bago ang length chunking).
- Discord soft cap: `channels.discord.maxLinesPerMessage` (default 17) naghahati ng mahahabang reply para maiwasan ang UI clipping.

**Boundary semantics:**

- `text_end`: i-stream ang mga block sa sandaling maglabas ang chunker; mag-flush sa bawat `text_end`.
- `message_end`: maghintay hanggang matapos ang mensahe ng assistant, saka i-flush ang naka-buffer na output.

`message_end` ay gumagamit pa rin ng chunker kung ang naka-buffer na teksto ay lumampas sa `maxChars`, kaya maaari itong maglabas ng maraming chunk sa dulo.

## Chunking algorithm (low/high bounds)

Ang block chunking ay ipinapatupad ng `EmbeddedBlockChunker`:

- **Low bound:** huwag maglabas hangga’t ang buffer ay >= `minChars` (maliban kung pinilit).
- **High bound:** mas gustong maghati bago ang `maxChars`; kung pinilit, maghati sa `maxChars`.
- **Break preference:** `paragraph` → `newline` → `sentence` → `whitespace` → hard break.
- **Code fences:** huwag kailanman maghati sa loob ng mga fence; kapag pinilit sa `maxChars`, isara at buksan muli ang fence para manatiling valid ang Markdown.

Ang `maxChars` ay naka-clamp sa channel `textChunkLimit`, kaya hindi ka maaaring lumampas sa mga per-channel cap.

## Coalescing (pagsasanib ng mga streamed block)

Kapag naka-enable ang block streaming, puwedeng **pagsamahin ng OpenClaw ang magkakasunod na block chunk**
bago ipadala. Binabawasan nito ang “single-line spam” habang nagbibigay pa rin
ng progresibong output.

- Naghihintay ang coalescing ng mga **idle gap** (`idleMs`) bago mag-flush.
- Ang mga buffer ay may cap na `maxChars` at magfa-flush kung lalampas dito.
- Pinipigilan ng `minChars` ang pagpapadala ng maliliit na fragment hangga’t hindi sapat ang naipong teksto
  (ang final flush ay laging nagpapadala ng natitirang teksto).
- Ang joiner ay hinango mula sa `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → space).
- May mga channel override sa pamamagitan ng `*.blockStreamingCoalesce` (kasama ang mga per-account config).
- Ang default na coalesce `minChars` ay itinataas sa 1500 para sa Signal/Slack/Discord maliban kung overridden.

## Human-like na pacing sa pagitan ng mga block

Kapag naka-enable ang block streaming, maaari kang magdagdag ng **randomized na pause** sa pagitan ng
mga block reply (pagkatapos ng unang block). Ginagawa nitong mas natural ang
pakiramdam ng mga multi-bubble na tugon.

- Config: `agents.defaults.humanDelay` (override kada agent sa pamamagitan ng `agents.list[].humanDelay`).
- Mga mode: `off` (default), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`).
- Nalalapat lamang sa **block replies**, hindi sa final replies o mga tool summary.

## “I-stream ang mga chunk o lahat”

Ito ay tumutugma sa:

- **I-stream ang mga chunk:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (maglabas habang nagpapatuloy). Kailangan din ng mga non-Telegram channel ang `*.blockStreaming: true`.
- **I-stream ang lahat sa dulo:** `blockStreamingBreak: "message_end"` (isang flush, posibleng maraming chunk kung napakahaba).
- **Walang block streaming:** `blockStreamingDefault: "off"` (final reply lamang).

**Tala sa channel:** Para sa mga non-Telegram channel, naka-**off** ang block streaming maliban kung
`*.blockStreaming` ay tahasang itinakda sa `true`. Maaaring mag-stream ng mga draft ang Telegram
(`channels.telegram.streamMode`) nang walang block replies.

Paalala sa lokasyon ng config: ang mga default ng `blockStreaming*` ay nasa ilalim ng
`agents.defaults`, hindi sa root config.

## Telegram draft streaming (token-ish)

Ang Telegram lang ang channel na may draft streaming:

- Gumagamit ng Bot API `sendMessageDraft` sa **private chats na may topics**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: mga update ng draft gamit ang pinakabagong stream text.
  - `block`: mga update ng draft sa mga chunked block (parehong mga patakaran ng chunker).
  - `off`: walang draft streaming.
- Config ng draft chunk (para lamang sa `streamMode: "block"`): `channels.telegram.draftChunk` (mga default: `minChars: 200`, `maxChars: 800`).
- Hiwalay ang draft streaming sa block streaming; naka-off ang mga block reply bilang default at pinapagana lamang ng `*.blockStreaming: true` sa mga non-Telegram channel.
- Ang final reply ay isang normal na mensahe pa rin.
- Isinusulat ng `/reasoning stream` ang reasoning sa loob ng draft bubble (Telegram lamang).

Kapag aktibo ang draft streaming, dini-disable ng OpenClaw ang block streaming para sa reply na iyon upang maiwasan ang double-streaming.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Legend:

- `sendMessageDraft`: Telegram draft bubble (hindi isang tunay na mensahe).
- `final reply`: normal na pagpapadala ng mensahe sa Telegram.
