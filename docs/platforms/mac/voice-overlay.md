---
summary: "Voice overlay lifecycle when wake-word and push-to-talk overlap"
read_when:
  - Adjusting voice overlay behavior
title: "Voice overlay"
---

# Voice Overlay Lifecycle (macOS)

Audience: macOS app contributors. Goal: keep the voice overlay predictable when wake-word and push-to-talk overlap.

Configure voice input under **Dashboard → Settings → Talk → This Mac**. The
overlay and microphone test remain native. The Dashboard owns their device
settings. See [Voice wake](/platforms/mac/voicewake) for the controls and permissions.

## Behavior

- The overlay can already be visible from wake-word when the user presses the hotkey. The hotkey session then adopts the existing text instead of resetting it. The overlay stays up while the hotkey is held. On release, send if there is trimmed text. Otherwise dismiss.
- Wake-word alone still auto-sends on silence. Push-to-talk sends immediately on release.

## Implementation

- `VoiceSessionCoordinator` (`apps/macos/Sources/OpenClaw/VoiceSessionCoordinator.swift`) is the single owner of the active voice session. It is a `@MainActor @Observable` singleton, not an actor. API: `startSession`, `updatePartial`, `finalize`, `sendNow`, `dismiss`, `updateLevel`, `snapshot`. Each session carries a `UUID` token. The coordinator drops calls with a stale or mismatched token.
- `VoiceWakeOverlayController` (`VoiceWakeOverlayController+Session.swift`) renders the overlay and forwards user actions (`requestSend`, `dismiss`) back through the coordinator via the session token. It never owns the session state itself.
- Push-to-talk (`VoicePushToTalk.begin()`) adopts any visible overlay text as `adoptedPrefix` (via `VoiceSessionCoordinator.shared.snapshot()`). A hotkey press while the wake overlay is up therefore keeps the text and appends new speech. On release, push-to-talk waits up to 1.5s for a final transcript before falling back to the current text.
- At dismissal start, the overlay calls `VoiceSessionCoordinator.overlayWillDismiss`; after the animation it calls `VoiceSessionCoordinator.overlayDidDismiss`. That call triggers `VoiceWakeRuntime.refresh(state:)`. Manual X-dismiss, empty-text dismiss, and post-send dismiss therefore all resume wake-word listening.
- Unified send path: if trimmed text is empty, dismiss. Otherwise the coordinator claims the token before route lookup and retains one send task. Manual send, queued auto-send, and push-to-talk cannot submit the same active attempt twice.
- While submission is pending, the overlay shows progress, not a sent checkmark. Only Gateway acceptance plays the send chime and dismisses as sent. An RPC failure keeps the transcript visible with a retry message; click Send or use the send shortcut to retry. An already-queued automatic callback never retries a failed attempt.
- Retries reuse the invocation's idempotency key only when the full payload and resolved delivery route are unchanged. Editing the transcript or changing the selected session or delivery target starts a new logical attempt. This is in-memory identity, not a durable outbox or an exactly-once delivery guarantee.
- Replacement or dismissal retires and cancels the owned task immediately, before any dismissal animation. Late route lookups cannot submit, and late RPC results cannot change a newer overlay. Cancellation cannot undo a request the Gateway already accepted.

## Logging

Voice subsystem is `ai.openclaw`. Each component logs under its own category:

| Category                | Component                                       |
| ----------------------- | ----------------------------------------------- |
| `voicewake.coordinator` | `VoiceSessionCoordinator`                       |
| `voicewake.overlay`     | `VoiceWakeOverlayController`/`VoiceWakeOverlay` |
| `voicewake.ptt`         | Push-to-talk hotkey and capture                 |
| `voicewake.runtime`     | Wake-word runtime                               |
| `voicewake.sync`        | Global settings sync                            |
| `voicewake.forward`     | Transcript forwarding                           |

## Debugging checklist

- Stream logs while reproducing a sticky overlay:

  ```bash
  sudo log stream --predicate 'subsystem == "ai.openclaw" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Verify only one active session token. The coordinator drops stale callbacks.
- Verify that push-to-talk release always calls `end()` with the active token. If text is empty, expect a dismiss without chime or send.

## Related

- [macOS app](/platforms/macos)
- [Voice wake (macOS)](/platforms/mac/voicewake)
- [Talk mode](/nodes/talk)
