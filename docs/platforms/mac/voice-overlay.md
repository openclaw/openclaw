---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Voice overlay lifecycle when wake-word and push-to-talk overlap"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adjusting voice overlay behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Voice Overlay"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Voice Overlay Lifecycle (macOS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Audience: macOS app contributors. Goal: keep the voice overlay predictable when wake-word and push-to-talk overlap.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Current intent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the overlay is already visible from wake-word and the user presses the hotkey, the hotkey session _adopts_ the existing text instead of resetting it. The overlay stays up while the hotkey is held. When the user releases: send if there is trimmed text, otherwise dismiss.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wake-word alone still auto-sends on silence; push-to-talk sends immediately on release.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Implemented (Dec 9, 2025)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Overlay sessions now carry a token per capture (wake-word or push-to-talk). Partial/final/send/dismiss/level updates are dropped when the token doesn’t match, avoiding stale callbacks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Push-to-talk adopts any visible overlay text as a prefix (so pressing the hotkey while the wake overlay is up keeps the text and appends new speech). It waits up to 1.5s for a final transcript before falling back to the current text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Chime/overlay logging is emitted at `info` in categories `voicewake.overlay`, `voicewake.ptt`, and `voicewake.chime` (session start, partial, final, send, dismiss, chime reason).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Next steps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **VoiceSessionCoordinator (actor)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Owns exactly one `VoiceSession` at a time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - API (token-based): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Drops callbacks that carry stale tokens (prevents old recognizers from reopening the overlay).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **VoiceSession (model)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Fields: `token`, `source` (wakeWord|pushToTalk), committed/volatile text, chime flags, timers (auto-send, idle), `overlayMode` (display|editing|sending), cooldown deadline.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Overlay binding**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `VoiceSessionPublisher` (`ObservableObject`) mirrors the active session into SwiftUI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `VoiceWakeOverlayView` renders only via the publisher; it never mutates global singletons directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Overlay user actions (`sendNow`, `dismiss`, `edit`) call back into the coordinator with the session token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Unified send path**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - On `endCapture`: if trimmed text is empty → dismiss; else `performSend(session:)` (plays send chime once, forwards, dismisses).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Push-to-talk: no delay; wake-word: optional delay for auto-send.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Apply a short cooldown to the wake runtime after push-to-talk finishes so wake-word doesn’t immediately retrigger.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Logging**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Coordinator emits `.info` logs in subsystem `bot.molt`, categories `voicewake.overlay` and `voicewake.chime`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Key events: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Debugging checklist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stream logs while reproducing a sticky overlay:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify only one active session token; stale callbacks should be dropped by the coordinator.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure push-to-talk release always calls `endCapture` with the active token; if text is empty, expect `dismiss` without chime or send.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Migration steps (suggested)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Add `VoiceSessionCoordinator`, `VoiceSession`, and `VoiceSessionPublisher`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Refactor `VoiceWakeRuntime` to create/update/end sessions instead of touching `VoiceWakeOverlayController` directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Refactor `VoicePushToTalk` to adopt existing sessions and call `endCapture` on release; apply runtime cooldown.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Wire `VoiceWakeOverlayController` to the publisher; remove direct calls from runtime/PTT.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Add integration tests for session adoption, cooldown, and empty-text dismissal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
