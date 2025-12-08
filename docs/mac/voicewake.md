# Voice Wake Pipeline

Updated: 2025-12-08 · Owners: mac app

## Runtime behavior
- Always-on listener (Speech framework) waits for any trigger word.
- On first trigger hit: start capture, raise ears immediately via `AppState.triggerVoiceEars(ttl: nil)`, reset capture buffer.
- While capturing: keep buffer in sync with partial transcripts; update `lastHeard` whenever audio arrives.
- End capture when 1.0s of silence is observed (or 8s hard stop), then call `stopVoiceEars()`, prepend the voice-prefix string, send once to Claude, and restart the recognizer for a clean next trigger. A short 350ms debounce prevents double-fires.

## Visual states
- **Listening for trigger:** idle icon.
- **Wake word detected / capturing:** ears enlarged with holes; stays up until silence end, not a fixed timer.
- **After send:** ears drop immediately when silence window elapses; icon returns to idle.

## Forwarding payload
- Uses `VoiceWakeForwarder.prefixedTranscript(_:)` to prepend the model hint:
  `User talked via voice recognition on <machine> - repeat prompt first + remember some words might be incorrectly transcribed.`
- Machine name resolves to Host.localizedName or hostName; caller can override for tests.

## Testing hooks
- Settings tester mirrors runtime: same capture/silence flow, same prefix, same ear behavior.
- Unit test: `VoiceWakeForwarderTests.prefixedTranscriptUsesMachineName` covers the prefix format.

## Tuning knobs (swift constants)
- Silence window: 1.0s (`silenceWindow` in `VoiceWakeRuntime`).
- Hard stop after trigger: 8s (`captureHardStop`).
- Post-send debounce: 0.35s (`debounceAfterSend`).
