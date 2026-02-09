---
summary: "Spraakactivering en push-to-talk-modi plus routeringsdetails in de mac-app"
read_when:
  - Werken aan spraakactivering- of PTT-paden
title: "Voice Wake"
---

# Spraakactivering & Push-to-Talk

## Modi

- **Wake-word-modus** (standaard): altijd-aan spraakherkenner wacht op trigger-tokens (`swabbleTriggerWords`). Bij een match start hij de opname, toont de overlay met gedeeltelijke tekst en verzendt automatisch na stilte.
- **Push-to-talk (rechter Option vasthouden)**: houd de rechter Option-toets ingedrukt om direct op te nemen—geen trigger nodig. De overlay verschijnt zolang je vasthoudt; loslaten rondt af en stuurt door na een korte vertraging zodat je de tekst nog kunt aanpassen.

## Runtime-gedrag (wake-word)

- Spraakherkenner draait in `VoiceWakeRuntime`.
- De trigger vuurt alleen wanneer er een **betekenisvolle pauze** is tussen het wake word en het volgende woord (~0,55 s gap). De overlay/klank kan al op de pauze starten, nog vóórdat het commando begint.
- Stiltevensters: 2,0 s wanneer spraak doorloopt, 5,0 s als alleen de trigger is gehoord.
- Harde stop: 120 s om ontsporende sessies te voorkomen.
- Debounce tussen sessies: 350 ms.
- Overlay wordt aangestuurd via `VoiceWakeOverlayController` met committed/volatile-kleuring.
- Na verzenden start de herkenner schoon opnieuw om naar de volgende trigger te luisteren.

## Levenscyclus-invarianten

- Als Spraakactivering is ingeschakeld en rechten zijn verleend, moet de wake-word-herkenner luisteren (behalve tijdens een expliciete push-to-talk-opname).
- Zichtbaarheid van de overlay (inclusief handmatig sluiten via de X-knop) mag nooit voorkomen dat de herkenner hervat.

## Vastzittende overlay-faalmodus (voorheen)

Eerder kon, als de overlay zichtbaar bleef hangen en je deze handmatig sloot, Spraakactivering “dood” lijken omdat de herstartpoging van de runtime geblokkeerd kon worden door de zichtbaarheid van de overlay en er geen volgende herstart werd gepland.

Versteviging:

- Herstart van de wake-runtime wordt niet langer geblokkeerd door de zichtbaarheid van de overlay.
- Voltooiing van overlay-sluiten triggert een `VoiceWakeRuntime.refresh(...)` via `VoiceSessionCoordinator`, zodat handmatig sluiten via de X altijd het luisteren hervat.

## Push-to-talk-specifiek

- Detectie van sneltoetsen gebruikt een globale `.flagsChanged`-monitor voor **rechter Option** (`keyCode 61` + `.option`). We observeren alleen events (geen onderschepping).
- De opname-pipeline leeft in `VoicePushToTalk`: start Spraak direct, streamt partials naar de overlay en roept `VoiceWakeForwarder` aan bij loslaten.
- Wanneer push-to-talk start pauzeren we de wake-word-runtime om concurrerende audio-taps te vermijden; na loslaten start deze automatisch opnieuw.
- Rechten: Microfoon + Spraak vereist; voor het zien van events is Toegankelijkheid/Input Monitoring-goedkeuring nodig.
- Externe toetsenborden: sommige bieden de rechter Option mogelijk niet zoals verwacht—bied een alternatieve sneltoets aan als gebruikers misses melden.

## Gebruikersinstellingen

- **Spraakactivering**-schakelaar: schakelt de wake-word-runtime in.
- **Houd Cmd+Fn ingedrukt om te praten**: schakelt de push-to-talk-monitor in. Uitgeschakeld op macOS < 26.
- Taal- en microfoonkeuzelijsten, live niveaumeter, trigger-woordtabel, tester (alleen lokaal; stuurt niet door).
- De microfoonkeuzelijst behoudt de laatste selectie als een apparaat loskoppelt, toont een losgekoppelde hint en valt tijdelijk terug op de systeemstandaard totdat het apparaat terugkeert.
- **Geluiden**: klanken bij detectie van de trigger en bij verzenden; standaard het macOS-systeemgeluid “Glass”. Je kunt voor elk event elk `NSSound`-laadbaar bestand kiezen (bijv. MP3/WAV/AIFF) of **Geen geluid** selecteren.

## Doorstuurgedrag

- Wanneer Spraakactivering is ingeschakeld, worden transcripties doorgestuurd naar de actieve gateway/agent (dezelfde lokale vs. externe modus die de rest van de mac-app gebruikt).
- Antwoorden worden afgeleverd bij de **laatst gebruikte hoofdprovider** (WhatsApp/Telegram/Discord/WebChat). Als levering mislukt, wordt de fout gelogd en blijft de run zichtbaar via WebChat/sessielogs.

## Doorstuur-payload

- `VoiceWakeForwarder.prefixedTranscript(_:)` plaatst de machine-hint vóór het verzenden. Gedeeld tussen wake-word- en push-to-talk-paden.

## Snelle verificatie

- Schakel push-to-talk in, houd Cmd+Fn vast, spreek, laat los: de overlay moet partials tonen en vervolgens verzenden.
- Tijdens vasthouden moeten de menubalk-oren vergroot blijven (gebruikt `triggerVoiceEars(ttl:nil)`); na loslaten krimpen ze.
