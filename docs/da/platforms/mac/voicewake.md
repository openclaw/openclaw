---
summary: "Voice wake- og push-to-talk-tilstande samt routingdetaljer i mac-appen"
read_when:
  - Arbejder med voice wake- eller PTT-stier
title: "Voice Wake"
x-i18n:
  source_path: platforms/mac/voicewake.md
  source_hash: f6440bb89f349ba5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:33Z
---

# Voice Wake & Push-to-Talk

## Tilstande

- **Wake-word-tilstand** (standard): altid-aktiv talegenkender venter på trigger-tokens (`swabbleTriggerWords`). Ved match starter den optagelse, viser overlayet med delvis tekst og sender automatisk efter stilhed.
- **Push-to-talk (hold højre Option)**: hold højre Option-tast nede for at optage med det samme—ingen trigger nødvendig. Overlayet vises, mens tasten holdes; når du slipper, færdiggøres og videresendes der efter en kort forsinkelse, så du kan justere teksten.

## Runtime-adfærd (wake-word)

- Talegenkenderen kører i `VoiceWakeRuntime`.
- Triggeren affyres kun, når der er en **meningsfuld pause** mellem wake-ordet og det næste ord (~0,55 s mellemrum). Overlay/klokketone kan starte på pausen, selv før kommandoen begynder.
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

- Hotkey-detektion bruger en global `.flagsChanged`-monitor for **højre Option** (`keyCode 61` + `.option`). Vi observerer kun hændelser (ingen “swallowing”).
- Optagelsespipelinen kører i `VoicePushToTalk`: starter Speech med det samme, streamer delvise resultater til overlayet og kalder `VoiceWakeForwarder` ved slip.
- Når push-to-talk starter, pauser vi wake-word-runtime for at undgå konkurrerende audio taps; den genstarter automatisk efter slip.
- Tilladelser: kræver Mikrofon + Tale; visning af hændelser kræver Accessibility/Input Monitoring-godkendelse.
- Eksterne tastaturer: nogle eksponerer muligvis ikke højre Option som forventet—tilbyd en fallback-genvej, hvis brugere rapporterer missede input.

## Brugerrettede indstillinger

- **Voice Wake**-toggle: aktiverer wake-word-runtime.
- **Hold Cmd+Fn for at tale**: aktiverer push-to-talk-monitoren. Deaktiveret på macOS < 26.
- Sprog- og mikrofonvælgere, live-niveaumåler, trigger-ordtabel, tester (kun lokal; videresender ikke).
- Mikrofonvælgeren bevarer det seneste valg, hvis en enhed frakobles, viser et frakoblet-hint og falder midlertidigt tilbage til systemets standard, indtil den vender tilbage.
- **Lyde**: klokketoner ved trigger-detektion og ved afsendelse; standard er macOS’ systemlyd “Glass”. Du kan vælge enhver `NSSound`-indlæselig fil (fx MP3/WAV/AIFF) for hver hændelse eller vælge **Ingen lyd**.

## Videresendelsesadfærd

- Når Voice Wake er aktiveret, videresendes transskriptioner til den aktive gateway/agent (samme lokale vs. remote-tilstand som resten af mac-appen).
- Svar leveres til den **senest anvendte hovedudbyder** (WhatsApp/Telegram/Discord/WebChat). Hvis levering fejler, logges fejlen, og kørslen er stadig synlig via WebChat/session-logs.

## Videresendelses-payload

- `VoiceWakeForwarder.prefixedTranscript(_:)` foranstiller maskin-hintet før afsendelse. Delt mellem wake-word- og push-to-talk-stier.

## Hurtig verifikation

- Slå push-to-talk til, hold Cmd+Fn, tal, slip: overlayet bør vise delvise resultater og derefter sende.
- Mens du holder, skal menulinje-ører forblive forstørrede (bruger `triggerVoiceEars(ttl:nil)`); de falder tilbage efter slip.
