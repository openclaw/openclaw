---
summary: "Röstväckning och push‑to‑talk‑lägen samt routningsdetaljer i mac‑appen"
read_when:
  - Arbetar med röstväckning eller PTT‑flöden
title: "Röstväckning"
x-i18n:
  source_path: platforms/mac/voicewake.md
  source_hash: f6440bb89f349ba5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:09Z
---

# Röstväckning & Push‑to‑talk

## Lägen

- **Väckords‑läge** (standard): alltid‑på‑talsigenkänning väntar på trigger‑token (`swabbleTriggerWords`). Vid träff startar inspelning, överlägget visas med partiell text och skickas automatiskt efter tystnad.
- **Push‑to‑talk (håll höger Option)**: håll ned höger Option‑tangent för att fånga ljud direkt—ingen trigger behövs. Överlägget visas medan tangenten hålls; släpp för att slutföra och vidarebefordra efter en kort fördröjning så att du kan justera texten.

## Körtidsbeteende (väckord)

- Talsigenkänningen körs i `VoiceWakeRuntime`.
- Triggern avfyras bara när det finns en **meningsfull paus** mellan väckordet och nästa ord (~0,55 s mellanrum). Överlägg/ljudsignal kan starta på pausen redan innan kommandot börjar.
- Tystnadsfönster: 2,0 s när tal pågår, 5,0 s om endast triggern hördes.
- Hårt stopp: 120 s för att förhindra skenande sessioner.
- Debounce mellan sessioner: 350 ms.
- Överlägget drivs via `VoiceWakeOverlayController` med färgsättning för bekräftad/volatil text.
- Efter sändning startar igenkännaren om rent för att lyssna efter nästa trigger.

## Livscykel‑invarianter

- Om Röstväckning är aktiverad och behörigheter är beviljade ska väckords‑igenkännaren lyssna (förutom under en explicit push‑to‑talk‑inspelning).
- Överläggets synlighet (inklusive manuell stängning via X‑knappen) får aldrig hindra igenkännaren från att återupptas.

## Felmod: klistrat överlägg (tidigare)

Tidigare, om överlägget fastnade synligt och du stängde det manuellt, kunde Röstväckning verka ”död” eftersom körtidens omstartsförsök kunde blockeras av överläggets synlighet och ingen efterföljande omstart schemalades.

Härdning:

- Omstart av väck‑körtiden blockeras inte längre av överläggets synlighet.
- Slutförd stängning av överlägget triggar en `VoiceWakeRuntime.refresh(...)` via `VoiceSessionCoordinator`, så manuell X‑stängning återupptar alltid lyssnandet.

## Push‑to‑talk‑detaljer

- Hotkey‑detektering använder en global `.flagsChanged`‑monitor för **höger Option** (`keyCode 61` + `.option`). Vi observerar endast händelser (ingen ”swallowing”).
- Inspelningspipeline körs i `VoicePushToTalk`: startar tal omedelbart, strömmar partialer till överlägget och anropar `VoiceWakeForwarder` vid släpp.
- När push‑to‑talk startar pausar vi väckords‑körtiden för att undvika konkurrerande ljudtappningar; den startar automatiskt igen efter släpp.
- Behörigheter: kräver Mikrofon + Tal; för att se händelser krävs tillstånd för Hjälpmedel/Inmatningsövervakning.
- Externa tangentbord: vissa kanske inte exponerar höger Option som förväntat—erbjud en reservgenväg om användare rapporterar missar.

## Användarinställningar

- **Röstväckning**‑växel: aktiverar väckords‑körtiden.
- **Håll Cmd+Fn för att tala**: aktiverar push‑to‑talk‑övervakningen. Inaktiverad på macOS < 26.
- Språk‑ och mikrofonväljare, live‑nivåmätare, tabell för triggerord, testare (endast lokalt; vidarebefordrar inte).
- Mikrofonväljaren bevarar senaste valet om en enhet kopplas bort, visar en frånkopplingshint och faller tillfälligt tillbaka till systemets standard tills enheten återkommer.
- **Ljud**: signaler vid trigger‑detektering och vid sändning; standard är macOS‑systemljudet ”Glass”. Du kan välja valfri `NSSound`‑laddningsbar fil (t.ex. MP3/WAV/AIFF) för varje händelse eller välja **Inget ljud**.

## Vidarebefordringsbeteende

- När Röstväckning är aktiverad vidarebefordras transkript till den aktiva gateway/agenten (samma lokala vs fjärrläge som används i övriga mac‑appen).
- Svar levereras till den **senast använda huvudleverantören** (WhatsApp/Telegram/Discord/WebChat). Om leverans misslyckas loggas felet och körningen är fortfarande synlig via WebChat/sessionloggar.

## Vidarebefordringspayload

- `VoiceWakeForwarder.prefixedTranscript(_:)` lägger till maskinhinten före sändning. Delas mellan väckords‑ och push‑to‑talk‑flöden.

## Snabb verifiering

- Slå på push‑to‑talk, håll Cmd+Fn, tala, släpp: överlägget ska visa partialer och sedan skicka.
- Medan du håller ska menyradens ”öron” vara förstorade (använder `triggerVoiceEars(ttl:nil)`); de faller tillbaka efter släpp.
