# Should automatic snippet expansion gain a generic dictation extension contract, or should initial work remain a manually invoked draft plugin?

## M07 — bounded static voice snippets

**Complete revised issue draft: DONE; committed as a file, not posted to the issue. Acceptance: NEEDS MAINTAINER. Implementation: PLAN ONLY; NOT READY FOR IMPLEMENTATION. Product proof: NOT COLLECTED. Runtime targets: UNMEASURED.**

This revision responds to the [durable feedback on #205639](https://github.com/openclaw/openclaw/issues/205639#issuecomment-7178316740): settle the extension/client boundary, fit existing preference limits and reconcile immediate feature revocation before implementation. The issue remains open, with no observed maintainer acceptance. The existing [fork draft #2](https://github.com/CompleteDotTech/openclaw/pull/2) is evidence to reassess, not an accepted upstream implementation or parent. Fresh review inventories returned no formal reviews or inline threads. [Source identity](checks/source-refresh.json)

## Problem

People dictating repeated short replies or signatures need to select their own saved wording deliberately while preserving literal spelling, punctuation, placeholders, line breaks and leading zeroes. Recognition, review and insertion must keep the text editable and unsent. A body that looks like a command, variable or URL is still text.

The first proposed slice is a tiny optional browser/en-US consumer: at most eight static records with bodies up to 256 UTF-8 bytes. It does not fulfill the original large-catalogue, mixed-intent or native/mobile scope.

## Options and recommendation

| Option | User flow | Tradeoff |
| --- | --- | --- |
| **Narrow generic finalized-dictation contract plus optional consumer — recommended conditionally** | Existing microphone capture → one finalized explicit command → source/expansion review → Apply → real Undo | Supports automatic voice expansion but requires accepted finality/source/draft metadata, literal placement, ordering and content storage. |
| **Manually invoked draft plugin** | User invokes a composer action, chooses a record and reviews an existing draft proposal | Smaller automatic integration scope, but not automatic voice support; concurrent edits, client scope and storage still need acceptance. |

Do not create another implementation PR to settle this choice. The latest instruction authorizes committing this design revision; it does not turn the bot's recommendation into owner acceptance.

## Proposed first flow

1. Through the accepted existing owner, the user explicitly enables the optional capability and authors a tiny static record. No actual preference key or new setting is accepted here.
2. Existing browser dictation receives a finalized transcript from the real configured provider. Start with one explicit command per finalized capture. Exact invocation words, case/Unicode normalization, escaping and en-US policy require acceptance.
3. At the accepted request-start boundary, obtain one admitted catalogue snapshot. Resolve an exact bounded trigger; do not use fuzzy/semantic matching, partial ASR, ordinary prose mentions or quoted mentions as automatic commands.
4. Produce one candidate from the original source. Existing review shows source and expansion; the user accepts or declines. Unknown names preserve source with an explanation. Ambiguity preserves source and requires a bounded explicit choice or cancellation. Never guess a winner.
5. Apply through the actual host input/editor owner after its existing source/input/target/request checks. Preserve full literal content and make one real Undo operation. No automatic Send or execution occurs.
6. If current input/target changed, capacity is insufficient, encoding cannot preserve the body or the outcome is uncertain, preserve recoverable text and show the accepted refusal/review path. Do not truncate, overwrite newer text, redirect to another target or repeat insertion blindly.

Exact body text is never interpolated, executed, fetched, expanded recursively or interpreted as another command. No new universal OS insertion, download/export mechanism, model runner or semantic regex classifier belongs in this slice.

## Host contract and existing owners

Extend only the accepted existing ownership boundary: `ComposerDictationOwner`, `ComposerDictationSession`, `ComposerDictationCommits`, the existing task/proposal owner and the real input/editor/Undo owner. There is no new capture manager, review manager, queue, settings service, authorization service or delivery ledger. Stopped recordings remain ordered even if a later provider finishes first. [Current capture owner](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/ui/src/pages/chat/composer-dictation.ts) · [Session and ordered commits](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/ui/src/pages/chat/composer-dictation-session.ts)

`ControlUiComposerHandle` supplies draft reads, setDraft, tasks and proposals, but no finalized-capture/source revision or protected-range contract. A stale whole-draft write cannot serve as automatic integration. Starting another task currently replaces the first; the accepted review/order contract must account for that without another queue. Proposal `insert` and `send` flags are outside this review-only flow. [SDK](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/src/plugin-sdk/control-ui.ts)

The proposed host seam supplies finalized source, existing capture/order/target identity and source/draft context. The consumer returns inert text with protected literal ranges or a visible abstention. The existing host owns review, input validation, complete placement and Undo. Exact type names, exported subpath/version, finality guarantees, range units and conflict outcomes remain NEEDS MAINTAINER. Proposed UTF-16 editor range offsets must remain distinct from UTF-8 storage limits.

At refreshed main `aa8288706247f3445242abf74395b9419100e665`, default prose placement trims, adds spacing and can call `truncateUtf16Safe` for the input maximum length. This newer capacity behavior reinforces the missing literal-placement contract: default-off transforms do not prove fidelity. A later literal path must preserve the whole approved body or visibly refuse it, without silently changing existing prose behavior. [Placement source](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/ui/src/pages/chat/composer-dictation-session.ts)

## Admission, cancellation and actual authority

Snapshot the catalogue once for the admitted feature request. Later edits, disabling or deletion affect new requests, including genuine retries/replays and newly queued work entering admission. An already admitted capture awaiting ordered delivery remains the same request. Do not reread policy, replace the admitted body or retire a candidate solely because the catalogue later changes.

Explicit Cancel, Discard and task Stop retire their work through the existing owner. Ordinary recording Stop releases capture and allows authorized final-transcript settlement. Starting a second recording must not globally invalidate an earlier stopped capture. Preserve actual owner/request-generation, input/source/target, identity, capability closure and commit/outcome checks. A lost response does not prove no effect occurred.

Keep existing `assertCurrent`, deferred credential-dispatch, inbound provider-frame and transcript-publication guards. Admission once cannot override rejected transport/session authority. The live callback requires abort without finalization on rejection, while authorized Stop may complete final drain. [Current authority contract](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/src/realtime-transcription/provider-types.ts) The [P02 review](https://github.com/openclaw/openclaw/pull/205876#issuecomment-7187811502) is prior coordination context, not M07 acceptance, a new consent source or borrowed proof.

## Concrete storage proposal without a cap increase

Use one existing authenticated profile preference value only if owners accept its content/access/retention policy. No key is reserved by this draft.

```json
{"version":1,"entries":[{"id":"s1","trigger":"status","body":"Build complete.","enabled":true}]}
```

| Boundary | Proposed requirement |
| --- | --- |
| Record count | 0–8 total, including disabled entries |
| ID | Unique proposed `[A-Za-z0-9_-]{1,16}`; at most 16 ASCII characters |
| Trigger | Nonempty; at most 64 UTF-8 bytes; accepted exact grammar/control policy |
| Body | Nonempty literal string; at most 256 UTF-8 bytes; no dynamic variables |
| Enabled | Boolean |
| Entire compact JSON value | At most 4,096 UTF-8 bytes including version, metadata, punctuation and escaping |
| Shared quotas | Unchanged 128 counted generic keys/profile and 32 entries/update; catalogue consumes one key/entry |

Reject malformed/unknown versions, unknown fields, collisions under the accepted grammar and oversized whole values before a partial write. Keep the prior value and unsaved edit visible. Do not truncate, delete unrelated preferences, shard across profile keys or reinstate the fork's 9-MiB reserved exception. [Current limits](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/packages/gateway-protocol/src/schema/user-profile-constants.ts) · [Validation](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/src/state/user-preferences.validation.ts)

Fresh standalone arithmetic measured a 26-byte envelope, 609-byte representative eight-record value and 3,097-byte maximal ordinary ASCII/selected multibyte value. With every flag false the latter is 3,105 bytes, leaving 991 bytes. Ordinary triggers with quote/backslash-heavy bodies occupy 5,145 bytes despite meeting raw field caps. The complete serialization must therefore be measured.

Propose a small disable reserve: actual bytes plus true-flag count must be <=4,096. Each true-to-false change adds exactly one byte. Actual 4,088/projected 4,096 fits; actual 4,089/projected 4,097 does not. All-false actual 4,096 fits. This reserve is proposed feature validation, not existing generic Gateway behavior. New metadata requires fresh accounting. [Calculation source](checks/catalogue-size-calculation.md) · [Actual numeric report](checks/catalogue-size-calculation.json)

Current authenticated `users.prefs` is remote account-profile storage, not browser-private. Native plugins share operator authority, with no per-plugin RPC allowlist. Generic expectedEntries is optional; an accepted writer could require the complete previous value. Expected null means absence; writing null removes the key. Preserve the existing handler/worker authority and conflict outcomes. Current profile merge keeps a target's existing key, can skip source keys at capacity and deletes source preference rows afterward. It does not guarantee preserving both catalogues. [Current source findings](checks/current-owner-facts.md)

The fork's 500-total/16-KiB-body/9-MiB value and reserved-key access/merge changes are unaccepted source proposals. No shipped M07 data contract or actual user-data migration requirement is established. If user-authored fork data exists, later authorized work must preserve it before any conversion or reduction. Import/export is deferred and cannot be assumed as recovery. A larger extension-owned persistent store is a separate deferred alternative.

## Shared preparation policy and siblings

The shared summary remains a proposal, not an accepted field: one `UiSettings` / `UiPreferences.dictationPreparation` object through existing settings functions, with version 1, literalProfile prose, punctuation preserve, and cleanup/correction/structure/refinement off. Allowed alternatives are developer-review, punctuation review, and off/review for the other transforms. Missing values preserve current prose defaults. Its proposed self-limit is 1 KiB.

Keep this browser/Gateway-scoped policy separate from bodies, transcripts, credentials and lifecycle state. It must remain outside the full `SYNCED_PREFS` descriptor and strict server `ui.prefs`; `configSync:false` alone may still allow profile sync. A type declaration alone is not persistence because settings load/save enumerate fields. Current source does not implement the field. M05 presets patch those same choices; M07/M06/P03 content needs its own accepted owner. [Current settings evidence](checks/current-owner-facts.md)

Coordinate [M11 #205845](https://github.com/openclaw/openclaw/issues/205845) and [M08 #205848](https://github.com/openclaw/openclaw/issues/205848). Their status is not newly certified by this iteration. Private M01–M05/M11 prototypes are not public APIs or accepted stack parents. M02/M03/M04/M11 must preserve protected snippet text and never reinterpret it as a command; an unavailable accepted integration must abstain/defer.

## Original acceptance criteria: explicit disposition

| ID | Original obligation | Revised disposition | Status | Product proof |
| --- | --- | --- | --- | --- |
| M07-AC01 | Exact explicit triggers once in utterance order; prose/literal escapes stay literal | One explicit command per finalized capture first; preserve capture order. Mixed multi-intent capture and exact grammar remain deferred/undecided. | NEEDS MAINTAINER | NOT COLLECTED |
| M07-AC02 | Useful handling of collision, disabled item and unknown name | Preserve source; bounded choice/error; no guessed expansion. Duplicate/content policy requires acceptance. | NEEDS MAINTAINER | NOT COLLECTED |
| M07-AC03 | Literal placeholders/dates/numbers/leading zeroes, no lookup/interpolation | Firm invariant for small static bodies. Whole body survives or insertion visibly refuses. | PLAN ONLY | NOT COLLECTED |
| M07-AC04 | Protected bytes survive enabled M11 transforms | Requires accepted shared literal placement/ranges and actual sibling proof; default-off transforms are insufficient. | NEEDS MAINTAINER | NOT COLLECTED |
| M07-AC05 | Catalogue/account/permission/cancellation races | Supersede blanket catalogue-driven retirement with admitted snapshot. Retain real authority/input/target/cancellation guards. | NEEDS MAINTAINER | NOT COLLECTED |
| M07-AC06 | Nested triggers, shell text, URLs and instructions stay inert | No evaluation, network side effect, recursion, reinterpretation or Send. | PLAN ONLY | NOT COLLECTED |
| M07-AC07 | Unsupported-target recovery; never send/execute | Browser draft first; preserve text and visibly refuse unsupported capacity/encoding. Broader adapters/recovery features deferred. | NEEDS MAINTAINER | NOT COLLECTED |
| M07-AC08 | Import/export round-trip and atomic invalid-input rejection | Import/export deferred; small editor writes still need atomic validation. Original round-trip criterion is not satisfied. | NEEDS MAINTAINER | NOT COLLECTED |
| M07-AC09 | Keyboard/screen-reader chooser, review, cancel and focus | Actual first-client keyboard and assistive technology required. Mobile/native unqualified. | PLAN ONLY | NOT COLLECTED |
| M07-AC10 | No default body/trigger logs; diagnostics separately controlled | No normal content logging. A new content-inspection mode is not part of this slice. | PLAN ONLY | NOT COLLECTED |
| M07-AC11 | Feature-off dictation/audio unchanged | Prove ordinary prose capacity handling, audio release, errors and late-final siblings remain unchanged. | PLAN ONLY | NOT COLLECTED |

## Required proof and rollout decision

Real qualification requires the exact accepted head, built Control UI served by an isolated real Gateway, a physical microphone, a supported real provider, source/expansion review, Apply, actual Undo and no automatic Send. Include unknown/ambiguous triggers, inert/Unicode/escaped content, whole-value boundaries, catalogue edits after admission, stale input/targets, capacity refusal without literal truncation, normal Stop/late final, reverse provider completion, Escape and actual keyboard/screen-reader behavior. Test accepted sibling transforms and a real latest-stable upgrade with unrelated preferences; any accepted persistence change also needs documented binary rollback/downgrade. [Detailed runbook](checks/qualification-runbook.md)

All such proof is NOT COLLECTED. Old fork claims, source inspection and this arithmetic are not product evidence. The original 25-ms p95/500-entry/4-KiB-body target is outside this slice and UNMEASURED; no new benchmark is claimed.

Defer original catalogue scale, mixed intents, import/export, sharing, cloud sync, new storage, native/mobile/external targets, broader locales and unaccepted refinement integrations. Static bodies, no dynamic variables, no execution and no Send remain firm. The historical attachment assigned no direct M07 Table 2 E2E row or Table 3 accepted parent row; neither is invented here.

Record the exact owner decisions before a later implementation task. This revision is committed as a document on the existing fork branch under the user's latest authorization; it is not posted as an issue/PR comment, a new PR, a re-review request, an issue closure or a successful review claim. [Readiness](pr-readiness.md)
