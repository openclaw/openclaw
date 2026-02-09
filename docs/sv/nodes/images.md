---
summary: "Regler för hantering av bilder och media för sändning, gateway och agentsvar"
read_when:
  - Ändring av mediepipeline eller bilagor
title: "Stöd för bilder och media"
---

# Stöd för bilder och media — 2025-12-05

WhatsApp-kanalen körs via **Baileys Web**. Detta dokument fångar aktuella regler för hantering av media för att skicka, gateway, och agent svarar.

## Mål

- Skicka media med valfria bildtexter via `openclaw message send --media`.
- Tillåta att autosvar från webbinboxen inkluderar media tillsammans med text.
- Hålla gränser per typ rimliga och förutsägbara.

## CLI-yta

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` valfritt; bildtexten kan vara tom för sändningar med enbart media.
  - `--dry-run` skriver ut den upplösta payloaden; `--json` skickar `{ channel, to, messageId, mediaUrl, caption }`.

## Beteende för WhatsApp Web-kanalen

- Indata: lokal filsökväg **eller** HTTP(S)-URL.
- Flöde: läs in till en Buffer, identifiera medietyp och bygg korrekt payload:
  - **Bilder:** ändra storlek och återkomprimera till JPEG (max sida 2048 px) med mål `agents.defaults.mediaMaxMb` (standard 5 MB), begränsat till 6 MB.
  - **Ljud/Röst/Video:** pass-through upp till 16 MB; ljud skickas som röstmeddelande (`ptt: true`).
  - **Dokument:** allt annat, upp till 100 MB, med filnamn bevarat när det finns.
- WhatsApp GIF-liknande uppspelning: skicka en MP4 med `gifPlayback: true` (CLI: `--gif-playback`) så att mobilklienter loopar inline.
- MIME-detektering prioriterar magic bytes, därefter headers och sedan filändelse.
- Bildtext hämtas från `--message` eller `reply.text`; tom bildtext är tillåten.
- Loggning: icke-verbose visar `↩️`/`✅`; verbose inkluderar storlek och källsökväg/URL.

## Auto-svarspipeline

- `getReplyFromConfig` returnerar `{ text?, mediaUrl?, mediaUrls? }`.
- När media finns, löser webbsändaren lokala sökvägar eller URL:er med samma pipeline som `openclaw message send`.
- Flera medieposter skickas sekventiellt om de anges.

## Inkommande media till kommandon (Pi)

- När inkommande webbmeddelanden innehåller media laddar OpenClaw ner till en temporär fil och exponerar mallvariabler:
  - `{{MediaUrl}}` pseudo-URL för inkommande media.
  - `{{MediaPath}}` lokal temporär sökväg som skrivs innan kommandot körs.
- När en Docker-sandbox per session är aktiverad kopieras inkommande media till sandbox-arbetsytan och `MediaPath`/`MediaUrl` skrivs om till en relativ sökväg som `media/inbound/<filename>`.
- Medieförståelse (om konfigurerad via `tools.media.*` eller delad `tools.media.models`) körs före mallning och kan infoga blocken `[Image]`, `[Audio]` och `[Video]` i `Body`.
  - Ljud sätter `{{Transcript}}` och använder transkriptionen för kommandotolkning så att snedstreckskommandon fortfarande fungerar.
  - Video- och bildbeskrivningar bevarar eventuell bildtext för kommandotolkning.
- Som standard behandlas endast den första matchande bilden/audio/videobilagan; sätt `tools.media.<cap>.attachments` för att bearbeta flera bilagor.

## Gränser och fel

**Utgående sändningsgränser (WhatsApp web send)**

- Bilder: ~6 MB-gräns efter återkomprimering.
- Ljud/röst/video: 16 MB-gräns; dokument: 100 MB-gräns.
- För stora eller oläsbara medier → tydligt fel i loggarna och svaret hoppas över.

**Gränser för medieförståelse (transkription/beskrivning)**

- Bild standard: 10 MB (`tools.media.image.maxBytes`).
- Ljud standard: 20 MB (`tools.media.audio.maxBytes`).
- Video standard: 50 MB (`tools.media.video.maxBytes`).
- För stora medier hoppar över förståelse, men svaren går ändå igenom med originaltexten.

## Noteringar för tester

- Täck sändnings- och svarsflöden för bild/ljud/dokument.
- Validera återkomprimering för bilder (storleksgräns) och röstmeddelandeflagga för ljud.
- Säkerställ att svar med flera medier fläktas ut som sekventiella sändningar.
