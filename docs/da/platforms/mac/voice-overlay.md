---
summary: "Livscyklus for voice overlay, når wake-word og push-to-talk overlapper"
read_when:
  - Justering af voice overlay-adfærd
title: "Voice Overlay"
---

# Voice Overlay-livscyklus (macOS)

Publikum: macOS app-bidragsydere. Målsætning: Hold stemmen overlejret forudsigeligt, når du vågner ord og push-to-talk overlapper hinanden.

## Nuværende hensigt

- Hvis overlejringen allerede er synlig fra wake-word og brugeren trykker på genvejstasten, genvejstasten session _adopts_ den eksisterende tekst i stedet for at nulstille den. Overlayet forbliver op, mens genvejstasten holdes. Når brugeren udgiver: Send hvis der er beskåret tekst, ellers afvise.
- Wake-word alene sender stadig automatisk ved stilhed; push-to-talk sender straks ved slip.

## Gennemført (9. Dec., 2025)

- Overlay sessioner nu bære en token per capture (wake-word eller push-to-talk). Dele/endelig/send/afvis/niveau opdateringer tabes, når token ikke matcher, undgå forsinke tilbagekald.
- Push-to-talk vedtager enhver synlig overlay tekst som et præfiks (så tryk på genvejstasten, mens den vågne overlay er oppe holder teksten og tilføjer ny tale). Den venter op til 1.5s for en endelig udskrift, før den falder tilbage til den aktuelle tekst.
- Klokke-/overlay-logging udsendes ved `info` i kategorierne `voicewake.overlay`, `voicewake.ptt` og `voicewake.chime` (sessionsstart, partial, final, send, dismiss, klokkeårsag).

## Næste trin

1. **VoiceSessionCoordinator (actor)**
   - Ejer præcis én `VoiceSession` ad gangen.
   - API (token-baseret): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Dropper callbacks, der bærer forældede tokens (forhindrer gamle genkendere i at genåbne overlayet).
2. **VoiceSession (model)**
   - Felter: `token`, `source` (wakeWord|pushToTalk), committed/volatile tekst, klokke-flag, timere (auto-send, idle), `overlayMode` (display|editing|sending), cooldown-deadline.
3. **Overlay-binding**
   - `VoiceSessionPublisher` (`ObservableObject`) spejler den aktive session ind i SwiftUI.
   - `VoiceWakeOverlayView` renderer udelukkende via publisheren; den muterer aldrig globale singletons direkte.
   - Overlay-brugerhandlinger (`sendNow`, `dismiss`, `edit`) kalder tilbage til koordinatoren med sessionens token.
4. **Samlet sendesti**
   - Ved `endCapture`: hvis trimmet tekst er tom → dismiss; ellers `performSend(session:)` (afspiller send-klokke én gang, videresender, lukker).
   - Push-to-talk: ingen forsinkelse; wake-word: valgfri forsinkelse for auto-send.
   - Anvend en kort cooldown på wake-runtime efter push-to-talk er færdig, så wake-word ikke straks retrigger.
5. **Logging**
   - Koordinatoren udsender `.info`-logs i subsystem `bot.molt`, kategorier `voicewake.overlay` og `voicewake.chime`.
   - Nøglehændelser: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## Fejlfindingscheckliste

- Stream logs, mens du reproducerer et fastlåst overlay:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Bekræft, at der kun er ét aktivt session-token; forældede callbacks bør droppes af koordinatoren.

- Sørg for, at slip af push-to-talk altid kalder `endCapture` med det aktive token; hvis teksten er tom, forvent `dismiss` uden klokke eller send.

## Migreringstrin (foreslået)

1. Tilføj `VoiceSessionCoordinator`, `VoiceSession` og `VoiceSessionPublisher`.
2. Refaktorer `VoiceWakeRuntime` til at oprette/opdatere/afslutte sessioner i stedet for at røre `VoiceWakeOverlayController` direkte.
3. Refaktorer `VoicePushToTalk` til at overtage eksisterende sessioner og kalde `endCapture` ved slip; anvend runtime-cooldown.
4. Kobl `VoiceWakeOverlayController` til publisheren; fjern direkte kald fra runtime/PTT.
5. Tilføj integrationstests for session-overtagelse, cooldown og lukning ved tom tekst.
