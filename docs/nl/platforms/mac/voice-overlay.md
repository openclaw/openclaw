---
summary: "Levenscyclus van de spraakoverlay wanneer wake-woord en push-to-talk overlappen"
read_when:
  - Afstemmen van het gedrag van de spraakoverlay
title: "Spraakoverlay"
---

# Levenscyclus van de spraakoverlay (macOS)

Doelgroep: macOS-appbijdragers. Doel: de spraakoverlay voorspelbaar houden wanneer wake-woord en push-to-talk overlappen.

## Huidige intentie

- Als de overlay al zichtbaar is door het wake-woord en de gebruiker de sneltoets indrukt, _adopteert_ de sneltoetssessie de bestaande tekst in plaats van deze te resetten. De overlay blijft zichtbaar zolang de sneltoets wordt ingedrukt. Wanneer de gebruiker loslaat: verzenden als er getrimde tekst is, anders sluiten.
- Alleen het wake-woord verzendt nog steeds automatisch bij stilte; push-to-talk verzendt direct bij loslaten.

## Geïmplementeerd (9 dec 2025)

- Overlay-sessies dragen nu per opname (wake-woord of push-to-talk) een token. Updates voor partial/final/send/dismiss/level worden genegeerd wanneer het token niet overeenkomt, om verouderde callbacks te voorkomen.
- Push-to-talk adopteert alle zichtbare overlaytekst als prefix (dus het indrukken van de sneltoets terwijl de wake-overlay actief is, behoudt de tekst en voegt nieuwe spraak toe). Het wacht tot 1,5 s op een definitief transcript voordat wordt teruggevallen op de huidige tekst.
- Chime-/overlaylogging wordt uitgezonden bij `info` in categorieën `voicewake.overlay`, `voicewake.ptt` en `voicewake.chime` (sessiestart, partial, final, verzenden, sluiten, reden van chime).

## Volgende stappen

1. **VoiceSessionCoordinator (actor)**
   - Beheert exact één `VoiceSession` tegelijk.
   - API (token-gebaseerd): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Negeert callbacks met verouderde tokens (voorkomt dat oude recognizers de overlay opnieuw openen).
2. **VoiceSession (model)**
   - Velden: `token`, `source` (wakeWord|pushToTalk), vastgelegde/vluchtige tekst, chime-vlaggen, timers (automatisch verzenden, inactiviteit), `overlayMode` (display|editing|sending), cooldown-deadline.
3. **Overlay-binding**
   - `VoiceSessionPublisher` (`ObservableObject`) spiegelt de actieve sessie naar SwiftUI.
   - `VoiceWakeOverlayView` rendert uitsluitend via de publisher; het muteert nooit direct globale singletons.
   - Overlay-gebruikersacties (`sendNow`, `dismiss`, `edit`) roepen terug naar de coordinator met het sessietoken.
4. **Eenvoudig verzendpad**
   - Bij `endCapture`: als getrimde tekst leeg is → sluiten; anders `performSend(session:)` (speelt het verzendgeluid één keer af, stuurt door, sluit).
   - Push-to-talk: geen vertraging; wake-woord: optionele vertraging voor automatisch verzenden.
   - Pas een korte cooldown toe op de wake-runtime nadat push-to-talk is beëindigd, zodat het wake-woord niet direct opnieuw triggert.
5. **Logging**
   - De coordinator emitteert `.info`-logs in subsysteem `bot.molt`, categorieën `voicewake.overlay` en `voicewake.chime`.
   - Sleutelgebeurtenissen: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## Debugging-checklist

- Stream logs terwijl je een vastzittende overlay reproduceert:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Verifieer dat er slechts één actief sessietoken is; verouderde callbacks moeten door de coordinator worden genegeerd.

- Zorg ervoor dat het loslaten van push-to-talk altijd `endCapture` aanroept met het actieve token; als de tekst leeg is, verwacht `dismiss` zonder chime of verzending.

## Migratiestappen (aanbevolen)

1. Voeg `VoiceSessionCoordinator`, `VoiceSession` en `VoiceSessionPublisher` toe.
2. Refactor `VoiceWakeRuntime` om sessies te maken/bij te werken/te beëindigen in plaats van `VoiceWakeOverlayController` direct aan te raken.
3. Refactor `VoicePushToTalk` om bestaande sessies te adopteren en bij loslaten `endCapture` aan te roepen; pas runtime-cooldown toe.
4. Verbind `VoiceWakeOverlayController` met de publisher; verwijder directe aanroepen vanuit runtime/PTT.
5. Voeg integratietests toe voor sessie-adoptie, cooldown en sluiten bij lege tekst.
