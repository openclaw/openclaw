# macOS system dictation proposal

This proposal gives maintainers one native workflow to decide jointly for
[P01 capture](https://github.com/openclaw/openclaw/issues/205853) and
[M10 insertion](https://github.com/openclaw/openclaw/issues/205846).
**Proposed only: native-owner acceptance, implementation, and platform qualification remain pending.**
This document enables no feature and certifies no insertion control.

## Decision requested

The [P01 review](https://github.com/openclaw/openclaw/issues/205853#issuecomment-7186720252)
and [M10 review](https://github.com/openclaw/openclaw/issues/205846#issuecomment-7186467107)
request one native scope, one first control, and explicit delivery semantics
before implementation. They also ask to reuse existing owners and simplify
generation, persistence, and repeated authorization machinery.

Accept or revise these choices together. Each remains **unaccepted**:

| Decision           | Proposed first scope                                                                                                         | Remaining decision                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow           | macOS native app, Apple Speech, a separate opt-in toggle shortcut, and review before insertion                               | Whether this dedicated native workflow belongs in the product                                                                                               |
| Ownership          | Extend `QuickChatController` and `QuickChatDictation`. Keep the M10 target/write boundary local to that native workflow      | Native versus plugin placement and the internal insertion boundary                                                                                          |
| First control      | TextEdit (`com.apple.TextEdit`), one plain-text document's editable `AXTextArea`, with one contiguous selection              | Accept this as a qualification candidate, not as supported behavior                                                                                         |
| Delivery guarantee | Preserve M10's original-target/selection requirement. Keep external insertion unavailable until the adapter can establish it | Accessibility attribute writes alone cannot provide an atomic selection-conditioned edit. Choose an adequate integration or explicitly revise the guarantee |
| Clipboard          | Explicit **Copy** only. No automatic paste, clipboard snapshot/restore, or fallback route in this first scope                | Accept the narrower clipboard policy                                                                                                                        |
| Limits and rollout | Default off, one session, bounded capture and finalization, no restart replay                                                | Accept concrete duration, timeout, and payload limits before implementation and measure them before qualification                                           |

TextEdit is a bounded research candidate because it provides a plain-text editing
task without a chat Send action. Its accessibility role, writable attributes, and
actual behavior still need inspection on a named macOS/TextEdit version. Neither
its application identifier nor an `AXTextArea` role proves safe insertion.

## Current source and dependency basis

The source inventory uses main at
[`cab8e5aca1c26f0a7b2fec0270ae5aa4153d48a2`](https://github.com/openclaw/openclaw/tree/cab8e5aca1c26f0a7b2fec0270ae5aa4153d48a2).
[Browser parent #204107](https://github.com/openclaw/openclaw/pull/204107)
merged on November 26, 2026, in
[`762aa006f9482f44d7975efe9cef2679d498c885`](https://github.com/openclaw/openclaw/commit/762aa006f9482f44d7975efe9cef2679d498c885).
That commit is an ancestor of the inspected main. Future P01 work therefore
targets main, without copying the browser parent's changes or retaining its
former branch as the base. The merge accepts no native insertion contract.

| Existing source                                                                                                                             | Current responsibility and proposed reuse                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [QuickChatController](Sources/OpenClaw/QuickChatController.swift)                                                                           | Owns native Quick Chat presentation, shortcut registration, composer dictation, and reply paste invocation. Extend this entry and lifecycle owner                            |
| [QuickChatDictation](Sources/OpenClaw/QuickChatDictation.swift) and [SpeechCaptureResources](Sources/OpenClaw/SpeechCaptureResources.swift) | Own the serial speech-capture work and resource cleanup. Reuse them instead of adding another recorder or provider hierarchy                                                 |
| [QuickChatFocusedTextCapture](Sources/OpenClaw/QuickChatFocusedTextCapture.swift)                                                           | Reads explicitly attached focused text. It is not a qualified original-selection writer                                                                                      |
| [QuickChatPaste](Sources/OpenClaw/QuickChatPaste.swift) and `pasteReplyToFrontmostApp`                                                      | Paste a completed assistant reply through the clipboard and Command-V to the app selected at invocation. Their success does not establish an original-control dictation edit |
| [macOS app guidance](AGENTS.md)                                                                                                             | Keeps device-local capabilities native and settings in the Dashboard through the existing device-settings bridge                                                             |

The current composer route requires visible Quick Chat and applies recognition
updates to its draft model. Its `stop()` releases capture and invalidates the
speech session. A future explicit-stop route must distinguish accepting a final
result from canceling capture. Existing cleanup alone does not prove finalization.

[P06](https://github.com/openclaw/openclaw/issues/205851#issuecomment-7186714681)
is a semantic reference: dictation yields text and cannot promote itself to Talk,
a send, or a tool action. Its unresolved browser interaction is not a native
gesture decision or a physical parent. M11 refinement and #187371 transport are
optional future consumers, not prerequisites for this first Apple Speech scope.

## Proposed user flow

1. The user enables the dedicated feature and chooses an available shortcut
   through the existing Dashboard device-settings route. Explain microphone,
   speech-recognition, and any later insertion permission separately. Denial or
   registration failure creates no recording. Existing Quick Chat shortcuts and
   Talk preferences do not imply opt-in.
2. On explicit activation, the native owner captures M10's original target
   reference **before** presenting, dismissing, or activating any OpenClaw window.
   An unavailable target permits visible capture with review/copy recovery. It
   never permits a guessed target.
3. The owner shows dictation mode, microphone status, a minimal application label,
   elapsed capture, **Stop**, and **Cancel**. Application switches do not stop
   recording or replace the target. All windows address the same native session.
4. The shortcut or **Stop** releases the microphone and accepts one finalization.
   The resulting text opens in review. Empty audio produces no insertion. A second
   Stop or final callback cannot create a second result or another delivery.
5. The user reviews the final text. **Insert** is available only for a qualified
   M10 route and the retained target. M10 checks that target's observable identity
   immediately before its edit. A changed, unsupported, or unverifiable target
   remains in review with **Copy** and **Discard**. Selecting a new target would
   require an explicit new review, not automatic recapture at delivery.
6. The owner presents M10's outcome once. **Copy** changes the clipboard only when
   chosen and leaves the copied text there. It does not also paste. After an
   uncertain attempted insertion, the user must inspect the target before choosing
   any manual recovery.

Ordinary composer dictation continues to produce an unsent draft. Existing Quick
Chat attachment, reply paste-back, and Talk remain separate intentional actions.
Dictated phrases, including commands, stay literal text. No path invokes an agent,
sends Enter, submits a form, or routes through the existing reply-paste command.
Terminal, password, payment, and otherwise sensitive or execution-capable controls
are outside the first insertion scope.

## Smallest state and effect boundary

The existing native controller remains the session owner. M10 owns the local
target adapter's validation, edit, and recorded outcome. The overlay displays
those facts. It must not perform a second paste routine.

Keep only state needed by a concrete failure:

| State                                              | Failure it prevents                                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Current capture request identity and capture phase | A canceled permission request or late speech callback starting or reviving a session. Reuse the existing request identity mechanism |
| One in-memory target reference and minimal label   | An app switch redirecting output. Native handles and any necessary selection/version evidence stay inside M10                       |
| One reviewed text revision                         | A streaming or later refinement callback changing the text after the user chooses Insert                                            |
| One pending effect and its outcome                 | Repeated Insert/Stop callbacks duplicating a write, or Cancel hiding an already attempted edit                                      |

Admit capture once on explicit Start and admit the separate insertion operation
once on explicit Insert. Checking target freshness before the write checks the
destination, not a new authorization ceremony. The platform still enforces its
actual permissions. A started indivisible edit may finish after cancellation or
permission loss. Cancel prevents future effects and does not promise rollback.

Use the controller's existing serialized coordination and `QuickChatDictation`'s
serial queue. Do not add a cross-process lease service, a persistent operation
queue, a second settings/provider hierarchy, or a public SDK/Gateway contract.
P01's proposed generation fields and M10's proposed persistence are not accepted
requirements for this first local route. Any additional mechanism needs a named
failure that the existing request identity and one pending effect cannot handle.

## TextEdit limitation and truthful outcomes

Apple's [attribute setter](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue?changes=_3)
accepts an element, attribute, and value. Apple's
[selected-text attribute](https://developer.apple.com/documentation/applicationservices/kaxselectedtextattribute?language=objc)
describes the element's current selection. **Design inference:** reading the
selection or document, checking it, and then setting selected text does not form
an atomic comparison and edit. Another edit or selection change can occur between
those calls. A readback can detect some differences after an effect but cannot
prevent that race or establish an unconditional transaction receipt.

Consequently, TextEdit remains **unqualified** for M10's strict original-selection
guarantee. A successful AX call, a matching readback, or deterministic tests cannot
silently redefine that guarantee. An owner decision may choose an integration
with an adequate edit/acknowledgment contract or explicitly accept narrower
semantics with their concrete risk. This proposal does not accept that risk on
the maintainer's behalf. Until then, any proposed route must remain review/copy-only.
This document enables neither capture nor insertion.

These outcome meanings constrain any later qualified adapter:

| Outcome                                | Evidence and recovery                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Inserted                               | The qualified control contract confirms the single intended edit. An API return that only confirms event delivery is insufficient |
| Not inserted                           | The adapter can establish that no edit began or took effect. Keep review available                                                |
| Canceled before effect                 | Cancellation reached the owner before the platform edit began. No write occurs                                                    |
| Unsupported, denied, or target changed | No edit is attempted. Explain the reason and offer review/copy                                                                    |
| Outcome unknown                        | An attempted edit cannot be confirmed or excluded. Retain that fact and ask the user to inspect the intended target               |

Repeated requests reuse the pending operation or its recorded result. Once an
edit is attempted, no automatic retry, fallback paste, new destination, or global
Undo follows. Cancel, disable, and overlay dismissal must not discard a late
inserted/unknown result. Keep that result inspectable in the current process,
including after the capture overlay closes. Restart returns idle with no replay
and makes no claim that a previous interrupted edit was rolled back. Durable
receipt recovery is a separate design decision, not an implicit transcript store.

## Lifecycle, privacy, and rollback

Every active capture remains visible and has accessible Stop and Cancel controls.
Extend [AppVoiceRuntime](Sources/OpenClaw/AppVoiceRuntime.swift)'s coordination of
`VoiceWakeRuntime`, `VoicePushToTalkHotkey`, and `TalkModeController` before starting
audio. Current Quick Chat capture does not join that coordination. The proposed
first policy rejects a conflicting activation with a visible busy state, without
preempting another voice workflow. It must cover admission from every participating
voice entry. Native-owner acceptance must settle that policy. Ending dictation
cannot accidentally resume ambient capture.

| Event                                                      | Proposed behavior                                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activation while preparing, recording, or finalizing       | Address the existing session. Stop/cancel preparation as documented, and never create another recorder                                                                                |
| Ordinary focus or visibility change                        | Keep explicit capture and the original target. Do not insert or submit                                                                                                                |
| Stop                                                       | Release the microphone, finish once, and show review. Bound finalization and report timeout without replaying audio                                                                   |
| Cancel or close capture overlay                            | Stop owned capture and prevent unstarted effects. Preserve any attempted edit's actual result                                                                                         |
| Lock or sleep                                              | Stop capture, conceal private preview text, and require fresh explicit activation after unlock/wake                                                                                   |
| Microphone removal, capture suspension, or permission loss | Stop and report the interruption. Never silently switch devices, stitch a capture gap, or restart recording                                                                           |
| Provider failure                                           | Preserve available recoverable text in review. Any retry requires explicit action and keeps its destination and provider choice visible                                               |
| Second window or Gateway reconnect                         | Use the existing native session. Neither creates a recorder nor replays delivery                                                                                                      |
| Disable                                                    | Unregister the new shortcut, release audio, cancel unstarted work, and close the overlay. Preserve attempted-edit results and existing composer drafts                                |
| Process restart                                            | Restore only previously explicit feature/shortcut preferences under the existing launch policy. Start with no active capture or queued delivery, and never replay an interrupted edit |
| Re-enable in the same process                              | Register only after explicit enablement. Keep any pending edit and its result inspectable, and do not start another edit while one remains pending                                    |

Keep audio only for capture/finalization needs and text only for the visible
session's recovery. Clear those resources on discard or normal completion. Do not
persist audio, transcript, field contents, or target handles. Avoid whole-document
reads to manufacture a revision check. If bounded metadata cannot establish a
safe target, reduce capability to review/copy. Default diagnostics contain only
timing and error/capability categories, never private text, target titles, or
credentials. The existing [interactive speech policy](Sources/OpenClaw/SpeechRecognitionRequestPolicy.swift)
does not require on-device recognition. Setup must disclose the selected speech
route without promising on-device-only processing. Local cancellation does not
promise erasure by a speech service.

Keyboard and VoiceOver operation must cover setup, every transition, review,
recovery, and cancel. Announce meaningful state changes without streaming every
token. Validate text scaling, reduced motion, full-screen apps, multiple displays,
and display removal. A hidden or unreachable overlay is not acceptable capture.

No upgrade enables this feature or changes an existing gesture. Rollback disables
new activation and insertion, preserves ordinary drafts and preferences, and
never replays text when the feature is enabled again.

## Qualification and acceptance ledger

All P01 acceptance criteria remain **NOT RUN / unmet by this document**. The
implementation must supply the following evidence on its actual source revision:

| P01 criterion                                    | Required evidence                                                                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC01: explicit, single visible session           | Real shortcut registration, conflicts, rejection, key repeat, and concurrent activation through the native owner                                                                   |
| AC02: focus tolerance and original target        | Start with Quick Chat already visible, capture the target before focus-changing work, switch applications, and verify no retarget or send                                          |
| AC03: one finalized result and approved delivery | Drive the actual owner with repeated Stop/final callbacks and Insert actions. Observe one accepted revision and at most one adapter effect                                         |
| AC04: cancellation around the effect             | Deterministically cancel before edit admission and during an indivisible attempt. Exercise inserted and unknown outcomes, late callbacks, visible recovery, and microphone release |
| AC05: interruption and explicit resume           | Real lock/unlock, sleep/wake, permission revoke, device removal, and suspension. Verify audio and ambient voice ownership stay stopped as specified                                |
| AC06: unsafe or unavailable target               | Real selected-control qualification plus stale selection/document, destroyed/reused control, secure field, unsupported app, and denial. No simulated typing                        |
| AC07: one owner across windows/reconnect         | Use two actual native windows and a reconnect. Observe one capture and one pending effect                                                                                          |
| AC08: accessible complete flow                   | Keyboard-only and VoiceOver operation, text scaling, full-screen presentation, multiple monitors, and display removal                                                              |
| AC09: existing behavior                          | Composer unsent draft, Quick Chat activation/attachment/reply paste-back, and unchanged Talk routing                                                                               |
| AC10: private diagnostics                        | Inspect default logs and error paths with synthetic audio, text, target labels, and credentials. None may appear                                                                   |
| AC11: measured performance                       | Named Mac, macOS build, input device, speech route, audio duration, sample size, cold/warm percentiles, memory, and slow-finalization behavior                                     |
| AC12: disable and rollback                       | Disable during preparation, capture, finalization, and attempted insertion. Verify shortcut/audio cleanup, truthful late outcomes, preserved drafts, and idle relaunch             |

P01's proposed activation target is p95 at most 150 ms. Its Cancel feedback target
is at most 100 ms. Neither is measured. Report UI acknowledgment, actual microphone
release, finalization latency, and memory separately. Agree and test maximum
capture duration, finalization timeout, and text size before calling them bounded.
Do not count failed or unknown insertions as successful latency samples.

M10's AC01–AC14 also remain open. This first candidate could only qualify the
named macOS control and common outcome, privacy, and accessibility rules. It
supplies no Windows, Linux, Android, or iOS support. Clipboard restoration is
outside this proposed route. Those requirements are deferred explicitly, not
satisfied by a fake adapter or by the existing Quick Chat paste-back behavior.

After the joint owner decision, implement the accepted local M10 boundary and
control qualification first. Integrate P01 through the existing native owner,
then prove the complete shortcut-to-outcome path and the regressions above.
Deterministic adapter fixtures establish ordering, not native support. A signed
macOS build, real permissions/microphone, the named target, and inspected native
UI evidence remain required. The current Linux documentation checks establish
none of those platform behaviors. Neither issue should close on this proposal
or on a partial implementation.
