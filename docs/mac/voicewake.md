# Voice Wake & Push-to-Talk

Updated: 2025-12-08 · Owners: mac app

## Modes
- **Wake-word mode** (default): always-on Speech recognizer waits for trigger tokens (`swabbleTriggerWords`). On match it starts capture, shows the overlay with partial text, and auto-sends after silence.
- **Push-to-talk (Cmd+Fn)**: hold Cmd+Fn to capture immediately—no trigger needed. The overlay appears while held; releasing finalizes and forwards after a short delay so you can tweak text.

## Runtime behavior (wake-word)
- Speech recognizer lives in `VoiceWakeRuntime`.
- Silence windows: 2.0s when speech is flowing, 5.0s if only the trigger was heard.
- Hard stop: 120s to prevent runaway sessions.
- Debounce between sessions: 350ms.
- Overlay is driven via `VoiceWakeOverlayController` with committed/volatile coloring.
- After send, recognizer restarts cleanly to listen for the next trigger.

## Push-to-talk specifics
- Hotkey detection uses a global `.flagsChanged` monitor: Fn is `keyCode 63` and flagged via `.function`; Command is `keyCode 55/54`. We only **observe** events (no swallowing).
- Capture pipeline lives in `VoicePushToTalk`: starts Speech immediately, streams partials to the overlay, and calls `VoiceWakeForwarder` on release.
- When push-to-talk starts we pause the wake-word runtime to avoid dueling audio taps; it restarts automatically after release.
- Permissions: requires Microphone + Speech. macOS will prompt the first time; seeing events needs Accessibility approval.
- Fn caveat: some external keyboards don’t expose Fn; fall back to a standard shortcut if needed.

## User-facing settings
- **Voice Wake** toggle: enables wake-word runtime.
- **Hold Cmd+Fn to talk**: enables the push-to-talk monitor. Disabled on macOS < 26.
- Language & mic pickers, live level meter, trigger-word table, tester, forward target/command all remain unchanged.
- **Sounds**: chimes on trigger detect and on send; defaults to the macOS “Glass” system sound. You can pick any `NSSound`-loadable file (e.g. MP3/WAV/AIFF) for each event or choose **No Sound**.

## Forwarding payload
- `VoiceWakeForwarder.prefixedTranscript(_:)` prepends the machine hint before sending. Shared between wake-word and push-to-talk paths.

## Quick verification
- Toggle push-to-talk on, hold Cmd+Fn, speak, release: overlay should show partials then send.
- While holding, menu-bar ears should stay enlarged (uses `triggerVoiceEars(ttl:nil)`); they drop after release.
