# macOS Talk Voice Selection + Voice Wake Follow-Up Design

Status: revised proposal
Owner: local dev branch / Ben + flicker
Scope: macOS app (`apps/macos`) and shared speech support (`apps/shared/OpenClawKit`)

## Summary

This design revises the original macOS voice-improvements plan to match the current mainline architecture.

It still targets the same two product goals:

1. **Configurable system voice for Talk Mode**
   - When Talk Mode uses local macOS system TTS, users can choose an exact installed macOS voice.
   - Selection is persisted by `AVSpeechSynthesisVoice.identifier`.

2. **Conversational follow-up after Voice Wake**
   - After a Voice Wake request is spoken and the assistant responds audibly, the app should support a short follow-up window.
   - If the user asks a quick follow-up within that window, the app should capture and send it without requiring a second wake word.
   - If no follow-up arrives before timeout, the app returns to normal wake-word-only behavior.

The key change from the original plan is architectural:

> **Voice Wake follow-up should no longer be modeled as “temporary Talk Mode”.**
>
> On current mainline, Voice Wake and Talk Mode are separate runtimes with different state machines, UX, and send paths. The best structure is to keep Talk Mode persistent and independent, while adding a Voice Wake-specific follow-up session model on top of the existing Voice Wake runtime/coordinator path.

This keeps the product intent while fitting the actual codebase cleanly.

---

## Why this design was revised

The original plan was written around an assumed relationship where Voice Wake effectively handed off into Talk Mode. That is no longer a good fit for current mainline.

### What changed since the original plan

Current mainline separates the relevant responsibilities like this:

- **Talk Mode**
  - `TalkModeRuntime`
  - `TalkModeController`
  - `TalkSystemSpeechSynthesizer`
  - persistent toggle via `AppState.talkEnabled`
  - continuous listening / speaking loop

- **Voice Wake**
  - `VoiceWakeRuntime`
  - `VoiceSessionCoordinator`
  - `VoiceWakeForwarder`
  - wake-word-triggered capture window
  - overlay-driven request/forward flow

### Current Voice Wake behavior

Today, Voice Wake:

1. detects wake phrase in `VoiceWakeRuntime`
2. captures a short transcript window
3. finalizes and forwards the transcript through `VoiceWakeForwarder`
4. restarts the recognizer for the next wake word

This is not currently a Talk Mode session. It is a separate one-shot capture/forward path.

### Current Talk Mode behavior

Today, Talk Mode:

1. is enabled explicitly through `talkEnabled`
2. runs its own recognition loop in `TalkModeRuntime`
3. chooses either ElevenLabs or local system speech for output
4. remains persistent until disabled

### Consequence

Trying to force Voice Wake follow-up behavior into a “temporary Talk Mode” abstraction would introduce avoidable coupling:

- Talk Mode UI and persistence semantics would become muddier
- Voice Wake would need to manipulate Talk Mode enabled state or fake a Talk session origin
- runtime responsibilities would blur between two already-distinct subsystems

So the revised design preserves the original product goal, but re-anchors Feature 2 inside the **Voice Wake architecture**, not the Talk Mode architecture.

---

## Goals

### Goal 1: Configurable system voice

Allow Talk Mode system TTS to use a specific installed macOS voice chosen in-app.

### Goal 1A: Tahoe-aware voice UX enhancements

Improve the voice picker and metadata using newer Apple APIs available on current Tahoe:

- voice quality
- voice traits
- Personal Voice authorization awareness
- live refresh when installed voices change

### Goal 2: Voice Wake follow-up window

After a Voice Wake request receives an audible assistant reply, keep a short Voice Wake-specific follow-up session alive so the user can ask a follow-up question without repeating the wake word.

---

## Non-goals

- No custom speech synthesis provider or audio unit work
- No SSML / expressive speech authoring
- No requirement to mirror macOS Accessibility “System Voice” automatically
- No mandatory Personal Voice-specific permission flow in v1
- No change to Talk Mode’s persistent/manual semantics
- No attempt to unify Voice Wake and Talk Mode into a single runtime in v1
- No generalized full-duplex spoken conversation framework in this milestone

---

## Architecture overview

## Feature 1 remains mostly unchanged

Feature 1 still belongs to the Talk Mode / system TTS path:

- `TalkModeRuntime.playSystemVoice(...)`
- `TalkSystemSpeechSynthesizer`
- macOS settings / local persisted preferences

That part of the original design remains sound.

## Feature 2 is restructured

Feature 2 should now be layered on the Voice Wake request lifecycle:

- request capture starts in `VoiceWakeRuntime`
- request text is forwarded via `VoiceWakeForwarder`
- assistant reply is delivered through normal app/gateway channels
- once the spoken reply for that Voice Wake-triggered request finishes, a **Voice Wake follow-up session** opens
- during the follow-up session, the app listens for speech without requiring a wake word
- timeout or completion returns the app to normal wake-word-only mode

This is a **Voice Wake follow-up state machine**, not a Talk Mode session.

---

## Feature 1: Configurable system voice

### Current behavior

`TalkSystemSpeechSynthesizer` currently uses language-based selection:

```swift
if let language, let voice = AVSpeechSynthesisVoice(language: language) {
    utterance.voice = voice
}
```

This chooses a voice by locale/language, not by a user-selected installed voice.

### Revised design

Add one new field to the local macOS Talk settings model:

```json
{
  "talk": {
    "macosVoiceIdentifier": "com.apple.speech.synthesis.voice.custom.siri.aaron.premium"
  }
}
```

The runtime selection order should be:

1. explicit configured `macosVoiceIdentifier`
2. language-based voice fallback
3. default utterance voice

### Important implementation note

This identifier is **local macOS app preference/state**, even if represented in the same general Talk config surface. It should not require a remote gateway feature to function.

### Logging

Add structured logs for:

- configured identifier
- resolved voice identifier
- resolved name
- quality / traits when available
- fallback reason

### Why Feature 1 still stands cleanly

Unlike Feature 2, the relevant code path is still straightforward and has not drifted architecturally. Current mainline adds watchdog hardening but does not conflict with explicit voice selection.

---

## Feature 2: Voice Wake follow-up window

## Product intent

The original user goal remains:

> After saying the wake word and receiving a spoken response, the user should be able to ask a brief follow-up naturally, without needing to say the wake word again immediately.

## Revised conceptual model

Instead of “temporary Talk Mode”, define a new concept:

### Voice Wake Follow-Up Session

A Voice Wake Follow-Up Session is a short-lived post-reply state in which:

- wake-word detection is temporarily bypassed
- direct speech capture is allowed
- the next utterance is treated as a follow-up to the prior Voice Wake request
- after timeout or completion, the system returns to ordinary Voice Wake mode

This session is:

- **created by Voice Wake**,
- **consumed by Voice Wake**,
- **independent from Talk Mode enablement**.

---

## Why not temporary Talk Mode?

### Problems with the original framing

If we modeled follow-up as temporary Talk Mode, we would need to answer awkward questions:

- Is `talkEnabled` true during the temporary session?
- Should the Talk overlay appear as if the user manually enabled Talk Mode?
- Should Talk Mode settings like pause/interrupt behave exactly the same?
- Who owns the session lifecycle: `TalkModeRuntime` or `VoiceWakeRuntime`?
- How do we avoid races with real manual Talk Mode already being enabled?

Those questions are symptoms of the abstraction mismatch.

### Better fit

A Voice Wake follow-up session avoids this by keeping ownership local:

- `VoiceWakeRuntime` owns speech capture state
- `VoiceSessionCoordinator` owns request/follow-up session UX state
- Talk Mode remains a separate persistent mode

---

## Proposed runtime model for Feature 2

Introduce an explicit Voice Wake post-reply lifecycle.

### New high-level states

At a conceptual level, Voice Wake should distinguish:

1. **Wake listening**
   - normal wake-word recognition active
2. **Triggered capture**
   - wake word heard, command/following speech being captured
3. **Request in flight**
   - transcript finalized and forwarded, waiting for assistant completion
4. **Reply playback**
   - assistant response is being spoken
5. **Follow-up listening**
   - short no-wake-word follow-up window active
6. **Cooldown / restore**
   - cleanup, then return to wake listening

Not all of these must be represented as a single enum initially, but the architecture should preserve this lifecycle.

---

## Trigger for opening follow-up listening

The follow-up session should begin only when all of the following are true:

1. the request originated from Voice Wake
2. the assistant reply was actually delivered with audible local speech playback
3. reply playback finished successfully (or reached a “speech complete” signal)
4. the feature is enabled and timeout > 0

This is important: opening the follow-up window merely because a Voice Wake request was forwarded is too early and will feel wrong.

The user expectation is “you answered me, now I can quickly ask one more thing.”

---

## Required architectural hook

The major missing piece in current mainline is a reliable way for the macOS app to know:

- this reply belongs to a Voice Wake-originated request
- local speech playback for that reply started/finished

So Feature 2 needs a lightweight correlation model.

### Proposed approach: Voice Wake request correlation token

When `VoiceWakeRuntime` forwards a request, attach a local request/session token to the request lifecycle on the macOS side.

The exact transport mechanism can vary, but architecturally we need:

- a **local session token** created at Voice Wake capture finalization
- a coordinator-owned record that marks that token as awaiting spoken reply
- a way for the reply playback path to signal start/finish against that token

### Design principle

Do **not** make Feature 2 depend on brittle transcript matching or “last reply wins” heuristics.

Correlation should be explicit if possible. If some gateway/channel surfaces make perfect correlation hard, the macOS-side implementation may use a narrower first version limited to the local chat/reply path where correlation is already knowable.

---

## Proposed ownership

### `VoiceWakeRuntime`

Responsible for:

- wake listening
- triggered capture
- follow-up listening capture
- transition back to wake mode

### `VoiceSessionCoordinator`

Responsible for:

- session token creation
- overlay/session lifecycle metadata
- whether a voice request is awaiting reply, in playback, or in follow-up window
- timer state for follow-up expiry

### speech playback path

Responsible for:

- reporting when a Voice Wake-correlated reply starts playback
- reporting when it finishes or fails

### `TalkModeRuntime`

Not responsible for follow-up session ownership.

Talk Mode may still provide implementation patterns for audio capture or playback behavior, but it should not become the state owner for Voice Wake follow-up.

---

## UI / UX semantics for Feature 2

### Settings language

The settings should avoid implying that manual Talk Mode is involved.

Recommended wording:

**Keep listening briefly for follow-up questions after a Voice Wake reply**

Help text:

> After OpenClaw answers a Voice Wake request out loud, keep listening for a short follow-up question without requiring the wake word again. If you stay silent until the timeout, OpenClaw returns to normal Voice Wake mode.

### Why this wording matters

It explains the behavior in user terms without leaking the internal runtime distinction.

---

## Detailed Feature 2 behavior

### Normal path

1. User says wake word + request
2. `VoiceWakeRuntime` captures and forwards transcript
3. app waits for response
4. response is spoken locally
5. after playback finishes, follow-up window opens
6. if user speaks within timeout:
   - capture follow-up utterance directly
   - send as follow-up request
   - await spoken reply again
   - optionally reopen follow-up window after that reply
7. if timeout expires:
   - exit follow-up window
   - restore wake-word listening only

### Timeout semantics

- config stored as milliseconds
- UI shown in seconds
- `0` or disabled means no follow-up window
- timeout starts after spoken reply playback completes, not when request is sent

### Retry / error semantics

If the reply is not spoken locally, do **not** enter follow-up mode.

If playback fails midway, default to returning to normal wake listening unless a later UX pass shows a better fallback.

### Manual Talk Mode interaction

If manual Talk Mode is already enabled, Feature 2 should not try to layer a Voice Wake follow-up window on top.

Recommended v1 rule:

- when manual Talk Mode is active, Voice Wake follow-up behavior is suppressed or considered irrelevant because continuous conversation is already available.

This avoids state conflicts and user confusion.

---

## Config

## Feature 1

```json
{
  "talk": {
    "macosVoiceIdentifier": "com.apple.speech.synthesis.voice.custom.siri.aaron.premium"
  }
}
```

## Feature 2

```json
{
  "talk": {
    "voiceWakeFollowupMs": 10000
  }
}
```

### Naming note

The old plan used `voiceWakeKeepAliveMs`.

The revised name `voiceWakeFollowupMs` is recommended because:

- it better describes the user-facing purpose
- it avoids implying that Talk Mode itself is being kept alive
- it fits the new architecture more honestly

If backward compatibility with prior local experimentation matters, the parser can accept both names temporarily and normalize to the new one.

---

## API and state implications

### Feature 1

- Extend `TalkSystemSpeechSynthesizer.speak(...)` to accept optional `voiceIdentifier`
- Persist local selected identifier in app state/settings
- thread the value into `TalkModeRuntime.playSystemVoice(...)`

### Feature 2

Needs new local coordination/state, likely along these lines:

- Voice Wake request/session token
- follow-up mode enabled flag + timeout
- callback/event when relevant reply playback starts/finishes
- timer-driven expiry back to wake listening

This should be implemented as incremental local architecture, not a giant refactor.

---

## Testing strategy

## Feature 1

### Unit tests

- identifier selection wins over language
- invalid identifier falls back to language
- missing identifier + missing language falls back to utterance default

### Manual checks

- choose a specific installed voice
- hear correct voice in Talk Mode
- invalid stored identifier falls back safely

## Feature 2

### Unit / state tests

- Voice Wake request opens “awaiting reply” state
- spoken reply completion opens follow-up listening state
- follow-up timeout returns to wake listening
- no spoken reply => no follow-up window
- manual Talk Mode active => follow-up window suppressed

### Integration tests

- local playback callback path can signal coordinator correctly
- Voice Wake follow-up capture sends a second utterance without requiring wake word

### Manual checks

- trigger Voice Wake, get spoken response, ask follow-up without wake word
- remain silent past timeout and confirm return to wake-word-only mode
- confirm manual Talk Mode behavior is unchanged

---

## Risks and mitigation

### Risk 1: reply correlation is messy

Mitigation:

- design around explicit local session tokens wherever possible
- scope v1 to the local audible-reply path only if necessary

### Risk 2: state conflicts with manual Talk Mode

Mitigation:

- explicitly keep Talk Mode separate
- suppress or bypass follow-up mode when manual Talk Mode is active

### Risk 3: users cannot tell which mode they are in

Mitigation:

- use overlay/coordinator states that clearly distinguish:
  - wake listening
  - processing reply
  - listening for follow-up

### Risk 4: accidental room speech gets captured during follow-up

Mitigation:

- short default timeout
- open window only after spoken reply finishes
- reset to wake mode aggressively on silence/timeout

---

## Recommended delivery sequence

1. **Milestone 1 — explicit macOS system voice selection**
   - low risk, direct user value, architecturally stable
2. **Milestone 2 — voice picker polish / Tahoe metadata**
   - quality-of-life layering on Feature 1
3. **Milestone 3 — Voice Wake follow-up architecture + runtime**
   - build on revised state model, not old temporary Talk Mode assumptions

---

## Final design decision

### Preserve the original product goals

Yes.

### Preserve the original implementation framing for Feature 2

No.

The correct current-mainline design is:

- **Feature 1** remains a Talk Mode / system TTS enhancement.
- **Feature 2** becomes a Voice Wake follow-up session feature, owned by Voice Wake runtime/coordinator state rather than temporary Talk Mode.

That is the cleanest way to deliver the original user experience without fighting the current architecture.
