---
summary: "Mga patakaran sa paghawak ng imahe at media para sa send, gateway, at agent replies"
read_when:
  - Pagbabago sa media pipeline o mga attachment
title: "Suporta sa Imahe at Media"
---

# Suporta sa Imahe at Media — 2025-12-05

Ang WhatsApp channel ay tumatakbo sa pamamagitan ng **Baileys Web**. Kinukunan ng dokumentong ito ang kasalukuyang mga patakaran sa paghawak ng media para sa send, gateway, at mga reply ng agent.

## Mga Layunin

- Magpadala ng media na may opsyonal na caption sa pamamagitan ng `openclaw message send --media`.
- Payagan ang mga auto-reply mula sa web inbox na magsama ng media kasama ng text.
- Panatilihing maayos at predictable ang mga limitasyon kada uri.

## CLI Surface

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` opsyonal; puwedeng walang laman ang caption para sa media-only na send.
  - `--dry-run` nagpi-print ng resolved payload; ang `--json` ay nag-e-emit ng `{ channel, to, messageId, mediaUrl, caption }`.

## Gawi ng WhatsApp Web channel

- Input: lokal na file path **o** HTTP(S) URL.
- Daloy: i-load sa isang Buffer, tukuyin ang uri ng media, at buuin ang tamang payload:
  - **Mga Imahe:** i-resize at i-recompress sa JPEG (max side 2048px) na tumatarget sa `agents.defaults.mediaMaxMb` (default 5 MB), may cap na 6 MB.
  - **Audio/Boses/Video:** pass-through hanggang 16 MB; ang audio ay ipinapadala bilang voice note (`ptt: true`).
  - **Mga Dokumento:** anumang iba pa, hanggang 100 MB, na pinananatili ang filename kapag available.
- WhatsApp GIF-style playback: magpadala ng MP4 na may `gifPlayback: true` (CLI: `--gif-playback`) para mag-loop inline sa mga mobile client.
- Mas inuuna ng MIME detection ang magic bytes, kasunod ang headers, pagkatapos ang file extension.
- Ang caption ay nagmumula sa `--message` o `reply.text`; pinapayagan ang walang laman na caption.
- Logging: ang non-verbose ay nagpapakita ng `↩️`/`✅`; ang verbose ay kasama ang laki at source path/URL.

## Auto-Reply Pipeline

- `getReplyFromConfig` ay nagbabalik ng `{ text?, mediaUrl?, mediaUrls?` }\`.
- Kapag may media, nireresolba ng web sender ang mga lokal na path o URL gamit ang parehong pipeline gaya ng `openclaw message send`.
- Maramihang media entry ay ipinapadala nang sunud-sunod kapag ibinigay.

## Papasok na Media sa Mga Command (Pi)

- Kapag ang papasok na web message ay may kasamang media, dina-download ito ng OpenClaw sa isang temp file at inilalantad ang mga templating variable:
  - `{{MediaUrl}}` pseudo-URL para sa papasok na media.
  - `{{MediaPath}}` lokal na temp path na naisusulat bago patakbuhin ang command.
- Kapag naka-enable ang per-session Docker sandbox, kinokopya ang papasok na media papunta sa sandbox workspace at ang `MediaPath`/`MediaUrl` ay nire-rewrite bilang relative path tulad ng `media/inbound/<filename>`.
- Ang pag-unawa sa media (kung naka-configure sa pamamagitan ng `tools.media.*` o shared `tools.media.models`) ay tumatakbo bago ang templating at maaaring magpasok ng mga block na `[Image]`, `[Audio]`, at `[Video]` sa `Body`.
  - Ang audio ay nagse-set ng `{{Transcript}}` at ginagamit ang transcript para sa command parsing upang patuloy na gumana ang mga slash command.
  - Ang mga deskripsyon ng video at imahe ay pinananatili ang anumang caption text para sa command parsing.
- Ang isang **node** ay isang kasamang device (macOS/iOS/Android/headless) na kumokonekta sa Gateway **WebSocket** (kaparehong port ng mga operator) na may `role: "node"` at naglalantad ng command surface (hal. `canvas.*`, `camera.*`, `system.*`) sa pamamagitan ng `node.invoke`.Mga detalye ng protocol: [Gateway protocol](/gateway/protocol).

## Mga Limitasyon at Error

**Mga outbound send cap (WhatsApp web send)**

- Mga imahe: ~6 MB cap pagkatapos ng recompression.
- Audio/boses/video: 16 MB cap; mga dokumento: 100 MB cap.
- Sobrang laki o hindi mabasang media → malinaw na error sa logs at nilalaktawan ang reply.

**Mga cap sa pag-unawa ng media (transcription/description)**

- Default ng imahe: 10 MB (`tools.media.image.maxBytes`).
- Default ng audio: 20 MB (`tools.media.audio.maxBytes`).
- Default ng video: 50 MB (`tools.media.video.maxBytes`).
- Ang sobrang laking media ay nilalaktawan ang pag-unawa, ngunit tuloy pa rin ang mga reply gamit ang orihinal na body.

## Mga Tala para sa Mga Test

- Saklawin ang send + reply flows para sa mga kaso ng imahe/audio/dokumento.
- I-validate ang recompression para sa mga imahe (size bound) at ang voice-note flag para sa audio.
- Tiyaking ang mga multi-media reply ay nagfa-fan out bilang sunud-sunod na send.
