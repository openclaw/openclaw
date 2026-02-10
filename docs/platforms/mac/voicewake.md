---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Voice wake and push-to-talk modes plus routing details in the mac app"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Working on voice wake or PTT pathways（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Voice Wake"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Voice Wake & Push-to-Talk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Wake-word mode** (default): always-on Speech recognizer waits for trigger tokens (`swabbleTriggerWords`). On match it starts capture, shows the overlay with partial text, and auto-sends after silence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Push-to-talk (Right Option hold)**: hold the right Option key to capture immediately—no trigger needed. The overlay appears while held; releasing finalizes and forwards after a short delay so you can tweak text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Runtime behavior (wake-word)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Speech recognizer lives in `VoiceWakeRuntime`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Trigger only fires when there’s a **meaningful pause** between the wake word and the next word (~0.55s gap). The overlay/chime can start on the pause even before the command begins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Silence windows: 2.0s when speech is flowing, 5.0s if only the trigger was heard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hard stop: 120s to prevent runaway sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Debounce between sessions: 350ms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Overlay is driven via `VoiceWakeOverlayController` with committed/volatile coloring.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- After send, recognizer restarts cleanly to listen for the next trigger.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Lifecycle invariants（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If Voice Wake is enabled and permissions are granted, the wake-word recognizer should be listening (except during an explicit push-to-talk capture).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Overlay visibility (including manual dismiss via the X button) must never prevent the recognizer from resuming.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sticky overlay failure mode (previous)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Previously, if the overlay got stuck visible and you manually closed it, Voice Wake could appear “dead” because the runtime’s restart attempt could be blocked by overlay visibility and no subsequent restart was scheduled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hardening:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wake runtime restart is no longer blocked by overlay visibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Overlay dismiss completion triggers a `VoiceWakeRuntime.refresh(...)` via `VoiceSessionCoordinator`, so manual X-dismiss always resumes listening.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Push-to-talk specifics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hotkey detection uses a global `.flagsChanged` monitor for **right Option** (`keyCode 61` + `.option`). We only observe events (no swallowing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Capture pipeline lives in `VoicePushToTalk`: starts Speech immediately, streams partials to the overlay, and calls `VoiceWakeForwarder` on release.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When push-to-talk starts we pause the wake-word runtime to avoid dueling audio taps; it restarts automatically after release.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Permissions: requires Microphone + Speech; seeing events needs Accessibility/Input Monitoring approval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- External keyboards: some may not expose right Option as expected—offer a fallback shortcut if users report misses.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## User-facing settings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Voice Wake** toggle: enables wake-word runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Hold Cmd+Fn to talk**: enables the push-to-talk monitor. Disabled on macOS < 26.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Language & mic pickers, live level meter, trigger-word table, tester (local-only; does not forward).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mic picker preserves the last selection if a device disconnects, shows a disconnected hint, and temporarily falls back to the system default until it returns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sounds**: chimes on trigger detect and on send; defaults to the macOS “Glass” system sound. You can pick any `NSSound`-loadable file (e.g. MP3/WAV/AIFF) for each event or choose **No Sound**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Forwarding behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When Voice Wake is enabled, transcripts are forwarded to the active gateway/agent (the same local vs remote mode used by the rest of the mac app).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replies are delivered to the **last-used main provider** (WhatsApp/Telegram/Discord/WebChat). If delivery fails, the error is logged and the run is still visible via WebChat/session logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Forwarding payload（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `VoiceWakeForwarder.prefixedTranscript(_:)` prepends the machine hint before sending. Shared between wake-word and push-to-talk paths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick verification（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Toggle push-to-talk on, hold Cmd+Fn, speak, release: overlay should show partials then send.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- While holding, menu-bar ears should stay enlarged (uses `triggerVoiceEars(ttl:nil)`); they drop after release.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
