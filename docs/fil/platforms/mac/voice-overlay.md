---
summary: "Lifecycle ng voice overlay kapag nagsasapawan ang wake-word at push-to-talk"
read_when:
  - Inaayos ang gawi ng voice overlay
title: "Voice Overlay"
---

# Lifecycle ng Voice Overlay (macOS)

23. Audience: mga contributor ng macOS app. 24. Layunin: panatilihing predictable ang voice overlay kapag nagsasabay ang wake-word at push-to-talk.

## Kasalukuyang layunin

- If the overlay is already visible from wake-word and the user presses the hotkey, the hotkey session _adopts_ the existing text instead of resetting it. Nanatiling nakikita ang overlay habang pinipindot ang hotkey. When the user releases: send if there is trimmed text, otherwise dismiss.
- Ang wake-word lang ay nag-a-auto-send pa rin kapag may katahimikan; ang push-to-talk ay nagse-send agad sa pag-release.

## Naipatupad (Dis 9, 2025)

- 27. Ang mga overlay session ay may dalang token bawat capture (wake-word o push-to-talk). 28. Ang mga partial/final/send/dismiss/level update ay dini-drop kapag hindi tumutugma ang token, upang maiwasan ang mga stale callback.
- Push-to-talk adopts any visible overlay text as a prefix (so pressing the hotkey while the wake overlay is up keeps the text and appends new speech). It waits up to 1.5s for a final transcript before falling back to the current text.
- Ang chime/overlay logging ay ine-emit sa `info` sa mga category na `voicewake.overlay`, `voicewake.ptt`, at `voicewake.chime` (session start, partial, final, send, dismiss, chime reason).

## Mga susunod na hakbang

1. **VoiceSessionCoordinator (actor)**
   - May-ari ng eksaktong isang `VoiceSession` sa anumang oras.
   - API (token-based): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Dini-drop ang mga callback na may dalang stale token (pinipigilan ang mga lumang recognizer na muling magbukas ng overlay).
2. **VoiceSession (model)**
   - Mga field: `token`, `source` (wakeWord|pushToTalk), committed/volatile text, mga chime flag, mga timer (auto-send, idle), `overlayMode` (display|editing|sending), cooldown deadline.
3. **Overlay binding**
   - `VoiceSessionPublisher` (`ObservableObject`) ay nagmi-mirror ng active session papunta sa SwiftUI.
   - Ang `VoiceWakeOverlayView` ay nagre-render lamang sa pamamagitan ng publisher; hindi ito direktang nagmu-mutate ng mga global singleton.
   - Ang mga user action sa overlay (`sendNow`, `dismiss`, `edit`) ay tumatawag pabalik sa coordinator gamit ang session token.
4. **Unified send path**
   - Sa `endCapture`: kung walang laman ang trimmed text → i-dismiss; kung hindi ay `performSend(session:)` (tumutugtog ng send chime nang isang beses, ipinapasa, at dini-dismiss).
   - Push-to-talk: walang delay; wake-word: opsyonal na delay para sa auto-send.
   - Mag-apply ng maikling cooldown sa wake runtime pagkatapos matapos ang push-to-talk para hindi agad mag-retrigger ang wake-word.
5. **Logging**
   - Ang coordinator ay nag-e-emit ng `.info` logs sa subsystem na `bot.molt`, mga category na `voicewake.overlay` at `voicewake.chime`.
   - Mga key event: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## Checklist sa pag-debug

- I-stream ang logs habang nire-reproduce ang sticky overlay:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- I-verify na iisa lang ang active session token; ang mga stale callback ay dapat dini-drop ng coordinator.

- Tiyaking ang pag-release ng push-to-talk ay laging tumatawag ng `endCapture` gamit ang active token; kung walang laman ang text, asahan ang `dismiss` na walang chime o send.

## Mga hakbang sa migration (iminumungkahi)

1. Magdagdag ng `VoiceSessionCoordinator`, `VoiceSession`, at `VoiceSessionPublisher`.
2. I-refactor ang `VoiceWakeRuntime` para lumikha/mag-update/magtapos ng mga session sa halip na direktang hawakan ang `VoiceWakeOverlayController`.
3. I-refactor ang `VoicePushToTalk` para i-adopt ang mga umiiral na session at tawagin ang `endCapture` sa pag-release; mag-apply ng runtime cooldown.
4. Ikabit ang `VoiceWakeOverlayController` sa publisher; alisin ang mga direktang tawag mula sa runtime/PTT.
5. Magdagdag ng mga integration test para sa session adoption, cooldown, at empty-text dismissal.
