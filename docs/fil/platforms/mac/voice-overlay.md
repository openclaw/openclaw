---
summary: "Lifecycle ng voice overlay kapag nagsasapawan ang wake-word at push-to-talk"
read_when:
  - Inaayos ang gawi ng voice overlay
title: "Voice Overlay"
x-i18n:
  source_path: platforms/mac/voice-overlay.md
  source_hash: 5d32704c412295c2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:48Z
---

# Lifecycle ng Voice Overlay (macOS)

Audience: mga contributor ng macOS app. Layunin: panatilihing predictable ang voice overlay kapag nagsasapawan ang wake-word at push-to-talk.

## Kasalukuyang layunin

- Kung nakikita na ang overlay mula sa wake-word at pinindot ng user ang hotkey, _ina-adopt_ ng hotkey session ang umiiral na text sa halip na i-reset ito. Nananatiling nakabukas ang overlay habang hawak ang hotkey. Kapag binitawan ng user: mag-send kung may trimmed text, kung hindi ay i-dismiss.
- Ang wake-word lang ay nag-a-auto-send pa rin kapag may katahimikan; ang push-to-talk ay nagse-send agad sa pag-release.

## Naipatupad (Dis 9, 2025)

- Ang mga overlay session ay may dala na ngayong token kada capture (wake-word o push-to-talk). Ang mga update na partial/final/send/dismiss/level ay dini-drop kapag hindi tugma ang token, para maiwasan ang mga stale callback.
- Ina-adopt ng push-to-talk ang anumang nakikitang overlay text bilang prefix (kaya kapag pinindot ang hotkey habang bukas ang wake overlay, nananatili ang text at dinadagdagan ng bagong speech). Naghihintay ito ng hanggang 1.5s para sa final transcript bago mag-fallback sa kasalukuyang text.
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
