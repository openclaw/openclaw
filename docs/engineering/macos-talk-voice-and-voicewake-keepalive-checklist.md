# Engineering Checklist: macOS Talk Voice Selection + Voice Wake Follow-Up

Status: active implementation plan
Scope: local development in `~/src/openclaw`
Commit strategy: complete each milestone fully, test it, and create a local commit before moving to the next milestone.

Related design doc:

- `docs/design/macos-talk-voice-and-voicewake-keepalive.md`

---

## Delivery strategy

We will deliver three milestones:

1. **Milestone 1 — Feature 1:** Configurable system voice baseline
2. **Milestone 2 — Feature 1A:** Tahoe-aware metadata, sorting, preview UX, live voice refresh
3. **Milestone 3 — Feature 2:** Voice Wake follow-up session architecture and runtime

Each milestone must satisfy all of the following before commit:

- implementation complete
- tests added/updated
- local build passes
- targeted manual verification complete
- local commit created

---

# Milestone 1 — Feature 1: Configurable system voice baseline

## Goal

Allow Talk Mode system TTS to use an exact installed macOS voice identified by a persisted voice identifier.

## Product outcome

- Users can choose a specific macOS voice.
- Talk Mode uses that exact voice when local system TTS is active.
- If the configured identifier is unavailable, runtime falls back safely.

## Config / model work

- [ ] Decide canonical local persistence location for `macosVoiceIdentifier`
- [ ] Ensure value round-trips cleanly
- [ ] Keep behavior backward-compatible when field is absent

## Runtime work

- [ ] Extend `TalkSystemSpeechSynthesizer` to accept optional explicit voice identifier
- [ ] Resolve configured voice using `AVSpeechSynthesisVoice(identifier:)`
- [ ] Fall back to `AVSpeechSynthesisVoice(language:)` when identifier is absent or unavailable
- [ ] Fall back again to utterance default behavior when no language is available
- [ ] Add logging for selected voice and fallback reasons
- [ ] Thread selected identifier from macOS app state/settings into `TalkModeRuntime.playSystemVoice(...)`
- [ ] Preserve existing watchdog / timeout behavior

## UI / state work

- [ ] Add minimal settings support for choosing between default system voice and specific voice
- [ ] Add basic installed-voice picker using identifier persistence
- [ ] Map identifier -> display name in the picker without storing the name separately
- [ ] Show warning state if saved identifier is not currently installed

## Unit tests

- [ ] Voice resolution test: exact identifier wins
- [ ] Voice resolution test: invalid identifier falls back to language
- [ ] Voice resolution test: no identifier + no language falls back to default behavior
- [ ] Logging/fallback path test where practical

## Integration / runtime tests

- [ ] Extend Talk runtime/system voice tests to verify explicit voice identifier path is used
- [ ] Verify no regression to ElevenLabs fallback logic
- [ ] Verify recent system-voice timeout watchdog behavior remains intact

## Manual verification

- [ ] Build app successfully
- [ ] Launch local app build
- [ ] Select a specific installed voice
- [ ] Confirm Talk Mode uses selected voice audibly
- [ ] Test with a deliberately invalid identifier and confirm graceful fallback

## Build / verification gates

- [ ] `pnpm build`
- [ ] `swift build --package-path apps/macos`
- [ ] `ALLOW_ADHOC_SIGNING=1 ./scripts/package-mac-app.sh`
- [ ] Relevant test target(s) pass

## Commit gate

- [ ] Review `git diff`
- [ ] Commit locally with milestone-specific message

### Suggested commit message

`feat(macos-talk): support explicit system voice selection by identifier`

---

# Milestone 2 — Feature 1A: Tahoe-aware metadata, sorting, preview UX, live voice refresh

## Goal

Polish the voice picker and preview behavior using the currently available Tahoe AVSpeech metadata and notifications.

## Product outcome

- Voice picker is quality-aware and easy to browse.
- Better voices appear first.
- Selecting a new voice plays a short preview.
- Picker can react if installed voices change while settings is open.

## Tahoe-aware feature work

- [ ] Add quality mapping: Premium / Enhanced / Standard
- [ ] Add system-language detection for grouping/sorting
- [ ] Availability-gate `voiceTraits` support on `macOS 14+`
- [ ] If available, surface `Personal Voice` / `Novelty` trait badges in the picker
- [ ] Availability-gate Personal Voice authorization awareness on `macOS 14+`
- [ ] Observe `AVSpeechSynthesizer.availableVoicesDidChangeNotification` and refresh voice catalog/UI

## Picker UX work

- [ ] Group voices into sections:
  - [ ] Premium — System Language
  - [ ] Enhanced — System Language
  - [ ] Standard — System Language
  - [ ] Premium — Other Languages
  - [ ] Enhanced — Other Languages
  - [ ] Standard — Other Languages
- [ ] Sort alphabetically within each section
- [ ] Show name + locale + quality badge per row
- [ ] Show trait badges when available

## Preview UX work

- [ ] Add preview service / helper that can speak a short sentence for the selected voice
- [ ] Stop/cancel current preview before playing a new one
- [ ] Trigger preview only when selection actually changes
- [ ] Do not auto-preview on initial settings load
- [ ] Reuse same underlying voice resolution path where practical

## Recommended architecture work

- [ ] Introduce voice catalog abstraction for easier testing
- [ ] Introduce preview synthesis abstraction for easier testing
- [ ] Add view model or helper layer for grouped/sorted picker data

## Unit tests

- [ ] Voice grouping test: system-language voices sorted before others
- [ ] Voice grouping test: Premium > Enhanced > Standard ordering
- [ ] Stable alphabetical ordering test within sections
- [ ] Trait mapping test on availability-gated code paths
- [ ] Preview logic test: selection change triggers one preview
- [ ] Preview logic test: same selection does not replay unnecessarily
- [ ] Preview logic test: second selection cancels previous preview
- [ ] Voice catalog refresh test for notification-driven updates

## Integration / runtime tests

- [ ] Voice picker model integration test with representative fake voice catalog
- [ ] Preview integration-style test through preview abstraction

## Manual verification

- [ ] Open settings and confirm grouped picker ordering is correct
- [ ] Confirm best voices in system language appear first
- [ ] Select multiple voices and confirm short preview plays on change
- [ ] Confirm preview does not fire on first render
- [ ] If possible, add/remove or download a voice and confirm picker refreshes

## Build / verification gates

- [ ] `pnpm build`
- [ ] `swift build --package-path apps/macos`
- [ ] `ALLOW_ADHOC_SIGNING=1 ./scripts/package-mac-app.sh`
- [ ] Relevant test target(s) pass

## Commit gate

- [ ] Review `git diff`
- [ ] Commit locally with milestone-specific message

### Suggested commit message

`feat(macos-talk): add quality-sorted voice picker with preview and Tahoe metadata`

---

# Milestone 3 — Feature 2: Voice Wake follow-up session

## Goal

After a Voice Wake request receives an audible spoken reply, keep a short follow-up listening window open so the user can ask a follow-up question without repeating the wake word.

## Product outcome

- Voice Wake feels conversational without becoming permanently open-ended.
- The user can ask a quick follow-up after an audible reply.
- Ambient room speech after a pause no longer keeps triggering replies indefinitely.
- Manual Talk Mode remains separate and unchanged.

## Architectural principles

- [ ] Do **not** model this as temporary Talk Mode
- [ ] Keep Talk Mode ownership in `TalkModeRuntime`
- [ ] Keep Voice Wake ownership in `VoiceWakeRuntime` + `VoiceSessionCoordinator`
- [ ] Treat follow-up as a Voice Wake-specific post-reply session
- [ ] Suppress or bypass follow-up mode when manual Talk Mode is already active

## Milestone 3A — correlation and state model

### Goal

Establish the local state model needed to know when a Voice Wake-originated request has received a spoken reply and is eligible for follow-up capture.

### State / model work

- [ ] Define Voice Wake request/session token model
- [ ] Add coordinator state for:
  - [ ] request pending / awaiting reply
  - [ ] reply playback active
  - [ ] follow-up listening active
  - [ ] follow-up expiry timer
- [ ] Decide where token/session state lives (`VoiceSessionCoordinator` recommended)
- [ ] Decide how Voice Wake-originated requests are correlated with reply playback lifecycle
- [ ] Ensure state cleanup on cancellation, stop, failure, and overlay dismissal

### Integration points

- [ ] Identify the local speech playback path(s) that can emit playback start/finish callbacks for Voice Wake-originated replies
- [ ] Add callback/event hooks needed for coordinator transitions
- [ ] Verify that silent/non-audible replies do not open follow-up mode

### Tests

- [ ] State test: Voice Wake request enters awaiting-reply state
- [ ] State test: spoken reply completion opens follow-up-ready state
- [ ] State test: playback failure / no audible reply does not open follow-up mode
- [ ] State test: cleanup clears token/session correctly

### Suggested commit message

`refactor(macos-voicewake): add follow-up session correlation model`

---

## Milestone 3B — runtime follow-up capture flow

### Goal

Teach `VoiceWakeRuntime` to enter a short no-wake-word follow-up capture window after a correlated spoken reply completes.

### Runtime work

- [ ] Add follow-up listening entry point in `VoiceWakeRuntime`
- [ ] Reuse as much existing capture/finalize logic as possible
- [ ] Distinguish wake-triggered capture from follow-up capture path where needed
- [ ] Start follow-up timer only after reply playback finishes
- [ ] Reset/close follow-up state after follow-up utterance is sent
- [ ] Return to ordinary wake listening after timeout or cleanup
- [ ] Ensure no double-trigger races with recognizer restart logic
- [ ] Ensure normal Voice Wake cooldown/restart behavior still works after follow-up completion

### Tests

- [ ] Runtime test: follow-up window opens after spoken reply completion
- [ ] Runtime test: speech inside follow-up window is captured without wake word
- [ ] Runtime test: silence timeout returns to wake listening
- [ ] Runtime test: follow-up flow does not regress ordinary wake-word flow

### Manual verification

- [ ] Trigger Voice Wake
- [ ] Receive spoken reply
- [ ] Ask short follow-up without wake word
- [ ] Confirm follow-up is sent successfully
- [ ] Stay silent past timeout and confirm return to wake listening

### Suggested commit message

`feat(macos-voicewake): add post-reply follow-up listening window`

---

## Milestone 3C — settings and UX polish

### Goal

Add user controls and clear UX language for the Voice Wake follow-up feature.

### Config / settings work

- [ ] Add persisted follow-up timeout setting using canonical name `voiceWakeFollowupMs`
- [ ] Optionally accept legacy experimental name `voiceWakeKeepAliveMs` if useful during development
- [ ] Keep UI in seconds but persist in milliseconds
- [ ] Support disabled / zero timeout cleanly

### UI work

- [ ] Add Voice Wake settings toggle:
  - [ ] `Keep listening briefly for follow-up questions after a Voice Wake reply`
- [ ] Add seconds slider with 1-second steps from 1 to 60
- [ ] Add synchronized whole-number numeric field (1–60)
- [ ] Add explanatory help text
- [ ] Add or update overlay/coordinator visual state if needed to distinguish follow-up listening from ordinary wake listening

### Tests

- [ ] Config parsing/state test for `voiceWakeFollowupMs`
- [ ] UI model test: slider and numeric field stay synchronized
- [ ] UI validation test: numeric field clamps/rejects out-of-range values
- [ ] UX/state test: manual Talk Mode active suppresses follow-up window behavior

### Manual verification

- [ ] Confirm settings copy is clear and does not imply Talk Mode is being enabled
- [ ] Confirm enabling/disabling feature updates behavior immediately or on next session as intended
- [ ] Confirm disabled setting fully suppresses follow-up mode

### Suggested commit message

`feat(macos-voicewake): add configurable follow-up timeout controls`

---

## Cross-milestone regression checks

- [ ] Manual Talk Mode behavior unchanged
- [ ] Voice Wake ordinary one-shot request path unchanged when follow-up feature disabled
- [ ] Existing system-voice fallback still works without ElevenLabs configuration
- [ ] Existing system-voice timeout watchdog still behaves correctly
- [ ] Overlay dismissal / recognizer restart remains stable
- [ ] No regressions in push-to-talk flow

---

## Final integration checklist

- [ ] Re-read the design doc before final polish
- [ ] Run full relevant tests
- [ ] Run local app build and packaged app test
- [ ] Review logs for voice selection and follow-up lifecycle clarity
- [ ] Review `git diff`
- [ ] Create final local commit(s)

---

## Recommended implementation order recap

1. Milestone 1 — explicit system voice selection baseline
2. Milestone 2 — voice picker polish / preview / Tahoe metadata
3. Milestone 3A — follow-up correlation model
4. Milestone 3B — follow-up capture runtime
5. Milestone 3C — follow-up settings + UX polish

This order keeps the low-risk Talk Mode voice improvements independent from the more architectural Voice Wake follow-up work while preserving the original product goals.
