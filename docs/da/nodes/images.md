---
summary: "Regler for håndtering af billeder og medier for send, gateway og agent-svar"
read_when:
  - Ændring af mediepipeline eller vedhæftninger
title: "Understøttelse af billeder og medier"
---

# Understøttelse af billeder og medier — 2025-12-05

WhatsApp-kanalen kører via **Baileys Web**. Dette dokument indfanger de aktuelle regler for håndtering af medier for send, gateway og agent svar.

## Mål

- Send medier med valgfri billedtekst via `openclaw message send --media`.
- Tillad, at autosvar fra webindbakken kan inkludere medier sammen med tekst.
- Hold grænser pr. type fornuftige og forudsigelige.

## CLI-overflade

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` valgfri; billedteksten kan være tom ved rene mediesendelser.
  - `--dry-run` udskriver den løste payload; `--json` udsender `{ channel, to, messageId, mediaUrl, caption }`.

## WhatsApp Web-kanalens adfærd

- Input: lokal filsti **eller** HTTP(S)-URL.
- Flow: indlæs i en Buffer, detektér medietype, og byg den korrekte payload:
  - **Billeder:** skaler og recomprimer til JPEG (maks. side 2048 px) med mål på `agents.defaults.mediaMaxMb` (standard 5 MB), begrænset til 6 MB.
  - **Lyd/Voice/Video:** pass-through op til 16 MB; lyd sendes som stemmenote (`ptt: true`).
  - **Dokumenter:** alt andet, op til 100 MB, med bevaret filnavn når muligt.
- WhatsApp GIF-lignende afspilning: send en MP4 med `gifPlayback: true` (CLI: `--gif-playback`), så mobilklienter looper inline.
- MIME-detektion foretrækker magic bytes, derefter headers, derefter filendelse.
- Billedtekst kommer fra `--message` eller `reply.text`; tom billedtekst er tilladt.
- Logning: ikke-verbose viser `↩️`/`✅`; verbose inkluderer størrelse og kilde-sti/URL.

## Auto-svar-pipeline

- `getReplyFromConfig` returnerer `{ text?, mediaUrl?, mediaUrls? }`.
- Når medier er til stede, løser webafsenderen lokale stier eller URL’er ved hjælp af samme pipeline som `openclaw message send`.
- Flere medieelementer sendes sekventielt, hvis de angives.

## Indgående medier til kommandoer (Pi)

- Når indgående webbeskeder indeholder medier, downloader OpenClaw til en temp-fil og eksponerer templating-variabler:
  - `{{MediaUrl}}` pseudo-URL for det indgående medie.
  - `{{MediaPath}}` lokal temp-sti skrevet før kommandoen køres.
- Når en per-session Docker-sandbox er aktiveret, kopieres indgående medier ind i sandbox-arbejdsområdet, og `MediaPath`/`MediaUrl` omskrives til en relativ sti som `media/inbound/<filename>`.
- Medieforståelse (hvis konfigureret via `tools.media.*` eller delt `tools.media.models`) kører før templating og kan indsætte `[Image]`, `[Audio]` og `[Video]`-blokke i `Body`.
  - Lyd sætter `{{Transcript}}` og bruger transskriptionen til kommandoparsning, så slash-kommandoer stadig virker.
  - Video- og billedbeskrivelser bevarer eventuel billedtekst til kommandoparsning.
- Som standard kun den første matchende billede/audio/video vedhæftet fil behandles; sæt `tools.media.<cap>.attachments` til at behandle flere vedhæftede filer.

## Grænser og fejl

**Udgående send-grænser (WhatsApp web send)**

- Billeder: ~6 MB grænse efter recomprimering.
- Lyd/voice/video: 16 MB grænse; dokumenter: 100 MB grænse.
- For store eller ulæselige medier → tydelig fejl i logs, og svaret springes over.

**Grænser for medieforståelse (transskription/beskrivelse)**

- Billeder standard: 10 MB (`tools.media.image.maxBytes`).
- Lyd standard: 20 MB (`tools.media.audio.maxBytes`).
- Video standard: 50 MB (`tools.media.video.maxBytes`).
- For store medier springer forståelse over, men svar sendes stadig med den oprindelige body.

## Noter til tests

- Dæk send- og svarflows for billed-/lyd-/dokument-tilfælde.
- Valider recomprimering for billeder (størrelsesgrænse) og stemmenote-flag for lyd.
- Sikr, at svar med flere medier fordeles som sekventielle sendelser.
