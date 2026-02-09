---
summary: "Röstväckning och push‑to‑talk‑lägen samt routningsdetaljer i mac‑appen"
read_when:
  - Arbetar med röstväckning eller PTT‑flöden
title: "Röstväckning"
---

# Röstväckning & Push‑to‑talk

## Lägen

- **Wake-word-läge** (standard): Alltid-on Speech recognizer väntar på triggertokens (`swabbleTriggerWords`). På matchen börjar fånga, visar överlappningen med partiell text, och auto-skickar efter tystnad.
- **Push-to-talk (Högeralternativ)**: håll rätt Optionsnyckel för att fånga omedelbart—ingen utlösare behövs. Överlagringen visas medan den hålls kvar; frisättningen slutför och framåt efter en kort fördröjning så att du kan justera texten.

## Körtidsbeteende (väckord)

- Talsigenkänningen körs i `VoiceWakeRuntime`.
- Trigger avfyrar bara när det finns en **meningsfull paus** mellan vaknordet och nästa ord (~0.55s gap). Overlay/chime kan starta på pausen redan innan kommandot börjar.
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

- Snabbtangent detektering använder en global `.flagsChanged` monitor för **rätt Alternativ** (`keyCode 61` + `.option`). Vi observerar bara händelser (ingen svälja).
- Inspelningspipeline körs i `VoicePushToTalk`: startar tal omedelbart, strömmar partialer till överlägget och anropar `VoiceWakeForwarder` vid släpp.
- När push‑to‑talk startar pausar vi väckords‑körtiden för att undvika konkurrerande ljudtappningar; den startar automatiskt igen efter släpp.
- Behörigheter: kräver Mikrofon + Tal; för att se händelser krävs tillstånd för Hjälpmedel/Inmatningsövervakning.
- Externa tangentbord: vissa kanske inte exponerar höger Option som förväntat—erbjud en reservgenväg om användare rapporterar missar.

## Användarinställningar

- **Röstväckning**‑växel: aktiverar väckords‑körtiden.
- **Håll Cmd+Fn för att prata**: aktiverar push-to-talk monitor. Inaktiverad på macOS < 26.
- Språk‑ och mikrofonväljare, live‑nivåmätare, tabell för triggerord, testare (endast lokalt; vidarebefordrar inte).
- Mikrofonväljaren bevarar senaste valet om en enhet kopplas bort, visar en frånkopplingshint och faller tillfälligt tillbaka till systemets standard tills enheten återkommer.
- **Ljud**: chimes vid avtryckardetektering och vid sändning; standard är macOS “Glass” systemljud. Du kan välja valfri `NSSound`-läsbar fil (t.ex. MP3/WAV/AIFF) för varje händelse eller välj **Inget Ljud**.

## Vidarebefordringsbeteende

- När Röstväckning är aktiverad vidarebefordras transkript till den aktiva gateway/agenten (samma lokala vs fjärrläge som används i övriga mac‑appen).
- Svaren levereras till den **senast använda huvudleverantören** (WhatsApp/Telegram/Discord/WebChat). Om leveransen misslyckas, är felet loggat och körningen fortfarande synlig via WebChat/sessionsloggar.

## Vidarebefordringspayload

- `VoiceWakeForwarder.prefixedTranscript(_:)` föreskriver maskinledtråden innan sändning. Delad mellan vakna-ord och push-to-talk vägar.

## Snabb verifiering

- Slå på push‑to‑talk, håll Cmd+Fn, tala, släpp: överlägget ska visa partialer och sedan skicka.
- Medan du håller ska menyradens ”öron” vara förstorade (använder `triggerVoiceEars(ttl:nil)`); de faller tillbaka efter släpp.
