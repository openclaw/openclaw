---
summary: "Voice wake- og push-to-talk-tilstande samt routingdetaljer i mac-appen"
read_when:
  - Arbejder med voice wake- eller PTT-stier
title: "Voice Wake"
---

# Voice Wake & Push-to-Talk

## Tilstande

- **Wake-word tilstand** (standard): altid-on Speech recognizer venter på trigger tokens (`swabbleTriggerWords`). På match starter det optagelse, viser overlejringen med delvis tekst, og auto-sender efter tavshed.
- **Push-to-talk (Right Option hold)**: hold den rigtige Option-nøgle nede for at fange med det samme – ingen udløser nødvendig. Overlayet vises mens holdt; udgivelse af færdiggør og fremad efter en kort forsinkelse, så du kan justere teksten.

## Runtime-adfærd (wake-word)

- Talegenkenderen kører i `VoiceWakeRuntime`.
- Udløser kun brand, når der er en **meningsfuld pause** mellem det vågne ord og det næste ord (~ 0,55s mellemrum). Overlægget/kimen kan starte på pausen, selv før kommandoen begynder.
- Stilhedsvinduer: 2,0 s når tale flyder, 5,0 s hvis kun triggeren blev hørt.
- Hård stop: 120 s for at forhindre løbske sessioner.
- Debounce mellem sessioner: 350 ms.
- Overlay styres via `VoiceWakeOverlayController` med committed/volatile-farver.
- Efter afsendelse genstarter genkenderen rent for at lytte efter næste trigger.

## Livscyklus-invarianter

- Hvis Voice Wake er aktiveret, og tilladelser er givet, skal wake-word-genkenderen lytte (undtagen under en eksplicit push-to-talk-optagelse).
- Overlay-synlighed (inkl. manuel lukning via X-knappen) må aldrig forhindre, at genkenderen genoptager.

## Sticky overlay-fejltilstand (tidligere)

Tidligere kunne Voice Wake fremstå “død”, hvis overlayet satte sig fast synligt, og du manuelt lukkede det, fordi runtime’ens genstartsforsøg kunne blive blokeret af overlay-synlighed, og ingen efterfølgende genstart blev planlagt.

Hærdning:

- Genstart af wake-runtime blokeres ikke længere af overlay-synlighed.
- Færdiggørelse af overlay-lukning udløser en `VoiceWakeRuntime.refresh(...)` via `VoiceSessionCoordinator`, så manuel X-lukning altid genoptager lytning.

## Push-to-talk-specifikke detaljer

- Hotkey detektion bruger en global `.flagsChanged` skærm for **right Option** (`keyCode 61` + `.option`). Vi observerer kun begivenheder (ingen synke).
- Optagelsespipelinen kører i `VoicePushToTalk`: starter Speech med det samme, streamer delvise resultater til overlayet og kalder `VoiceWakeForwarder` ved slip.
- Når push-to-talk starter, pauser vi wake-word-runtime for at undgå konkurrerende audio taps; den genstarter automatisk efter slip.
- Tilladelser: kræver Mikrofon + Tale; visning af hændelser kræver Accessibility/Input Monitoring-godkendelse.
- Eksterne tastaturer: nogle eksponerer muligvis ikke højre Option som forventet—tilbyd en fallback-genvej, hvis brugere rapporterer missede input.

## Brugerrettede indstillinger

- **Voice Wake**-toggle: aktiverer wake-word-runtime.
- **Hold Cmd+Fn nede for at tale**: muliggør push-to-talk skærmen. Deaktiveret på macOS < 26.
- Sprog- og mikrofonvælgere, live-niveaumåler, trigger-ordtabel, tester (kun lokal; videresender ikke).
- Mikrofonvælgeren bevarer det seneste valg, hvis en enhed frakobles, viser et frakoblet-hint og falder midlertidigt tilbage til systemets standard, indtil den vender tilbage.
- \*\*Lyde \*\*: chimes on trigger detect and on send; defaults to the macOS “Glass” system lyd. Du kan vælge en `NSSound`-belastbar fil (f.eks. MP3/WAV/AIFF) for hver begivenhed eller vælge \*\*Ingen Lyd \*\*.

## Videresendelsesadfærd

- Når Voice Wake er aktiveret, videresendes transskriptioner til den aktive gateway/agent (samme lokale vs. remote-tilstand som resten af mac-appen).
- Svar leveres til den **sidst brugte hovedudbyder** (WhatsApp/Telegram/Discord/WebChat). Hvis leveringen mislykkes, er fejlen logget og kørslen stadig synlig via WebChat / session logs.

## Videresendelses-payload

- `VoiceWakeForwarder.prefixedTranscript(_:)` forbereder maskinen vink før du sender. Delt mellem wake-word og push-to-talk stier.

## Hurtig verifikation

- Slå push-to-talk til, hold Cmd+Fn, tal, slip: overlayet bør vise delvise resultater og derefter sende.
- Mens du holder, skal menulinje-ører forblive forstørrede (bruger `triggerVoiceEars(ttl:nil)`); de falder tilbage efter slip.
