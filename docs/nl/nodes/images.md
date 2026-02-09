---
summary: "Regels voor beeld- en mediaverwerking voor verzenden, Gateway en agentantwoorden"
read_when:
  - Wijzigen van mediapipeline of bijlagen
title: "Ondersteuning voor Afbeeldingen en Media"
---

# Afbeeldingen & Media-ondersteuning — 2025-12-05

Het WhatsApp-kanaal draait via **Baileys Web**. Dit document beschrijft de huidige regels voor mediaverwerking voor verzenden, Gateway en agentantwoorden.

## Doelen

- Media verzenden met optionele bijschriften via `openclaw message send --media`.
- Automatische antwoorden vanuit de webinbox toestaan om media naast tekst te bevatten.
- Per-type limieten beheersbaar en voorspelbaar houden.

## CLI-oppervlak

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` optioneel; het bijschrift kan leeg zijn voor alleen-media-verzendingen.
  - `--dry-run` toont de opgeloste payload; `--json` geeft `{ channel, to, messageId, mediaUrl, caption }` uit.

## Gedrag van het WhatsApp Web-kanaal

- Invoer: lokaal bestandspad **of** HTTP(S)-URL.
- Verloop: laden in een Buffer, mediatype detecteren en de juiste payload opbouwen:
  - **Afbeeldingen:** verkleinen en hercomprimeren naar JPEG (max. zijde 2048px) met doel `agents.defaults.mediaMaxMb` (standaard 5 MB), begrensd op 6 MB.
  - **Audio/Spraak/Video:** doorgeven tot 16 MB; audio wordt verzonden als een spraakbericht (`ptt: true`).
  - **Documenten:** al het overige, tot 100 MB, met bestandsnaam behouden indien beschikbaar.
- WhatsApp GIF-achtige weergave: verzend een MP4 met `gifPlayback: true` (CLI: `--gif-playback`) zodat mobiele clients inline loopen.
- MIME-detectie geeft de voorkeur aan magic bytes, daarna headers en vervolgens de bestandsextensie.
- Bijschrift komt uit `--message` of `reply.text`; een leeg bijschrift is toegestaan.
- Logging: niet-verbose toont `↩️`/`✅`; verbose bevat grootte en bronpad/URL.

## Auto-antwoord-pipeline

- `getReplyFromConfig` retourneert `{ text?, mediaUrl?, mediaUrls? }`.
- Wanneer media aanwezig is, lost de webzender lokale paden of URL's op met dezelfde pipeline als `openclaw message send`.
- Meerdere media-items worden sequentieel verzonden indien opgegeven.

## Inkomende media naar opdrachten (Pi)

- Wanneer inkomende webberichten media bevatten, downloadt OpenClaw naar een tijdelijk bestand en stelt templating-variabelen beschikbaar:
  - `{{MediaUrl}}` pseudo-URL voor de inkomende media.
  - `{{MediaPath}}` lokaal tijdelijk pad dat wordt geschreven vóór het uitvoeren van de opdracht.
- Wanneer een per-sessie Docker-sandbox is ingeschakeld, wordt inkomende media gekopieerd naar de sandbox-werkruimte en worden `MediaPath`/`MediaUrl` herschreven naar een relatief pad zoals `media/inbound/<filename>`.
- Media-inzicht (indien geconfigureerd via `tools.media.*` of gedeelde `tools.media.models`) draait vóór templating en kan `[Image]`, `[Audio]` en `[Video]`-blokken invoegen in `Body`.
  - Audio stelt `{{Transcript}}` in en gebruikt het transcript voor opdrachtparsing zodat slash-opdrachten blijven werken.
  - Video- en afbeeldingsbeschrijvingen behouden eventuele bijschrifttekst voor opdrachtparsing.
- Standaard wordt alleen de eerste overeenkomende afbeelding/audio/video-bijlage verwerkt; stel `tools.media.<cap>.attachments` in om meerdere bijlagen te verwerken.

## Limieten & Fouten

**Uitgaande verzendlimieten (WhatsApp web send)**

- Afbeeldingen: ~6 MB limiet na hercompressie.
- Audio/spraak/video: 16 MB limiet; documenten: 100 MB limiet.
- Te grote of onleesbare media → duidelijke fout in logs en het antwoord wordt overgeslagen.

**Limieten voor media-inzicht (transcriptie/beschrijving)**

- Afbeeldingen standaard: 10 MB (`tools.media.image.maxBytes`).
- Audio standaard: 20 MB (`tools.media.audio.maxBytes`).
- Video standaard: 50 MB (`tools.media.video.maxBytes`).
- Te grote media slaan inzicht over, maar antwoorden gaan nog steeds door met de oorspronkelijke inhoud.

## Notities voor Tests

- Dek verzend- en antwoordstromen af voor gevallen met afbeeldingen/audio/documenten.
- Valideer hercompressie voor afbeeldingen (groottebegrenzing) en de spraakbericht-vlag voor audio.
- Zorg dat antwoorden met meerdere media uitwaaieren als sequentiële verzendingen.
