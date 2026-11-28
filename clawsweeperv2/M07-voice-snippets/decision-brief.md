# Should automatic snippet expansion gain a generic dictation extension contract, or should initial work remain a manually invoked draft plugin?

## M07 decision brief

**Design revision: DONE. Acceptance: NEEDS MAINTAINER. Implementation: PLAN ONLY; NOT READY FOR IMPLEMENTATION. Product proof: NOT COLLECTED. Runtime targets: UNMEASURED.**

Recommend a small generic finalized-dictation contract owned by the existing composer, with an optional tiny snippet consumer and browser/en-US as the first proposed automatic surface. A manually invoked draft plugin using existing proposals is the explicit alternative. Neither choice is accepted merely because it is described here.

The user's latest instruction authorizes committing ClawSweeper-requested revisions and prohibits comments. This commit makes the requested design reviewable on the existing fork branch. It does not implement an unaccepted public hook, modify runtime storage, open another PR, post a review, or infer approval from the bot.

## Fresh review and source identity

[Issue #205639](https://github.com/openclaw/openclaw/issues/205639) remains open with P3, needs-product-decision and no-new-fix-pr labels. The sole [durable comment](https://github.com/openclaw/openclaw/issues/205639#issuecomment-7178316740) was reviewed at `2026-11-26T00:15:21.209Z`, against source commit `26898ee0732b9ef426d175503a07ea6c76be3324`, with implementation marker `sha=na`. No human acceptance is recorded. Its requests are a narrow extension/client decision, a catalogue within existing limits and reconciliation of immediate feature revocation.

[Fork PR #2](https://github.com/CompleteDotTech/openclaw/pull/2) remains an open draft, observed head `7d8c99e9683ab86d65452d3de71ed3aa8463e6cc`, base `b7bd237d00508e0999c7a3fc6e36bc32bf421098`, both in CompleteDotTech/openclaw. Fresh REST and connector inventories return no comments, formal reviews or inline threads. No durable ClawSweeper PR review or reviewed PR SHA is established; connector pagination is not exposed. Old PR-body test/benchmark assertions are attributed historical reports.

Current upstream main was refreshed once to **`aa8288706247f3445242abf74395b9419100e665`**. The earlier packet used `3c3a83bb62095dba9c7641acd033d4b87db6d820`; it is historical evidence. [Source receipt](checks/source-refresh.json)

## Concrete choices

| Option                                                                                          | First user flow                                                                                                   | Benefit                                                                                      | Cost / acceptance needed                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Generic finalized-dictation seam plus optional tiny consumer — recommended conditionally** | Existing physical capture → finalized explicit command → source/expansion review → Apply → existing Undo; no Send | Serves the automatic use case while keeping optional snippet behavior outside the core owner | Composer/SDK acceptance of a narrow versioned API, finality/source/draft metadata, ordered review and exact literal placement; accepted content storage and real-client proof |
| **2. Manual draft plugin**                                                                      | User invokes a composer action, chooses a snippet and reviews a replacement proposal                              | Uses more of the existing API and avoids promising automatic capture integration             | Still needs accepted client/content/concurrent-edit semantics. It does not fulfill automatic voice expansion.                                                                 |

Do not silently implement option 2 while option 1 is undecided. The accepted choice defines the milestone and its claims.

## Existing owners and missing boundary

Retain `ComposerDictationOwner` for gesture/admission, `ComposerDictationSession` for capture/settlement, `ComposerDictationCommits` for capture-ordered delivery, and the real input/editor for placement, metadata and Undo. `ComposerDictationCommits` and `placeComposerDictation` both live in `composer-dictation-session.ts`. Do not add a capture manager, review owner, semantic runner, authorization service, delivery queue or persistent receipt ledger. [Capture](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/ui/src/pages/chat/composer-dictation.ts) · [Session/order/placement](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/ui/src/pages/chat/composer-dictation-session.ts)

Current `ControlUiComposerHandle` exposes draft read/write, tasks and proposals. It does not expose finalized capture/source identity, source revision/ranges or protected literal spans. Its task owner offers review and a single editor change with Undo, but starting another task replaces the prior task. Neither stale whole-draft `setDraft` nor blindly starting one task per completed capture proves ordered automatic support. Do not use proposal `insert` or `send` flags for this review-only flow. [SDK](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/src/plugin-sdk/control-ui.ts) · [Task/Undo owner](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/ui/src/lib/chat/composer-tasks.runtime.ts)

**New source finding in this iteration:** prose placement now calls `truncateUtf16Safe` when the input has a maximum length, in addition to trimming and adding spaces. Exact snippet output cannot be claimed through that path merely by disabling transforms. A later accepted literal path must preserve the entire body or visibly refuse insertion while retaining recoverable source/candidate text. It must not silently shorten a snippet or change ordinary prose behavior to solve an unaccepted feature. This is a source finding, not a reproduced product failure. [Current placement source](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/ui/src/pages/chat/composer-dictation-session.ts)

### Proposed contract responsibilities — no accepted exported signature

| Responsibility     | Proposed host fact/operation                                                                                                        | Consumer limit                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission          | The existing owner determines when this feature request starts and supplies a single admitted catalogue/policy snapshot             | Newly queued work, genuine retries and replays enter current admission. A continuation of admitted ordered work does not reread feature policy. |
| Finalized source   | Immutable original source with existing capture identity, finality, capture order, source revision and target binding               | Never infer finality or identity from text equality/partial ASR. Recognize only the accepted bounded explicit grammar.                          |
| Candidate          | One inert result plus source-to-output mapping and protected literal ranges, or a visible abstention                                | No body evaluation, network lookup, interpolation, recursion, fuzzy semantic selection or new model runner.                                     |
| Review             | Existing proposal owner shows original source and expansion and obtains Apply/decline                                               | No automatic setDraft/insert/send. Preserve unknown, ambiguous and cancelled text.                                                              |
| Apply              | Existing input owner checks current source/input/target/request context, capacity and outcome, then creates one real Undo operation | Never overwrite newer text or a different target, truncate literals, or retry an uncertain effect blindly.                                      |
| Ordered settlement | Existing commit owner and accepted one-card review policy preserve earlier stopped captures                                         | No parallel queue or global generation that kills all older stopped captures.                                                                   |

Owners must accept the actual callback/export/version, metadata types, finality guarantee, range indexing units, conflict outcome and review-order behavior. A proposed JavaScript-editor range convention would use UTF-16 offsets into the exact source string, while storage limits use UTF-8 bytes; those units must not be conflated. This is a design choice for review, not a new API exported by this commit.

## Lifecycle: one feature admission, existing authority preserved

| Event                                                    | Proposed or retained behavior                                                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry edited, disabled or deleted after admission        | New requests see the new catalogue. Admitted work may finish from its original snapshot; do not substitute a same-name body, reread policy or automatically retire it solely for that edit. |
| Explicit review Cancel, Discard or task Stop             | Retire that work through its existing owner. Late continuation cannot revive it.                                                                                                            |
| Ordinary recording Stop                                  | Release capture and allow authorized final-transcript settlement. Stop is not Discard.                                                                                                      |
| New recording while an earlier stopped capture drains    | Preserve earlier ordered settlement; later provider completion must not overtake it.                                                                                                        |
| Actual input/target/request-generation mismatch          | Preserve existing correctness guards; surface recovery rather than overwrite or redirect.                                                                                                   |
| Existing session/requester/transport authority rejection | Preserve `assertCurrent`, credential-dispatch, inbound-frame and transcript-publication guards. Feature admission never overrides them.                                                     |
| Timeout or lost response                                 | Use the existing commit/write outcome owner; no blind repeat.                                                                                                                               |

The live-authority callback still explicitly requires abort without finalization when it rejects. [Current contract](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/src/realtime-transcription/provider-types.ts) The prior [P02 repair review](https://github.com/openclaw/openclaw/pull/205876#issuecomment-7187811502) is coordination context for these existing boundaries, not acceptance of M07 or full P02. This iteration does not borrow P02 test results or claim its current review state was refreshed. No new consent setting, lease, fence or repeated feature authorization is proposed. [Current admission rules](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/AGENTS.md)

## Tiny existing-store proposal

Propose one versioned value through an accepted existing content owner, with no accepted key yet:

```json
{
  "version": 1,
  "entries": [{ "id": "s1", "trigger": "status", "body": "Build complete.", "enabled": true }]
}
```

Limit the value to 0–8 total entries including disabled ones, unique proposed `[A-Za-z0-9_-]{1,16}` IDs, nonempty triggers up to 64 UTF-8 bytes, nonempty literal bodies up to 256 UTF-8 bytes and a boolean enabled field. Reject unknown fields/versions, invalid content, collisions under the accepted grammar and oversized complete compact JSON visibly, with no partial write or silent truncation.

Keep **4,096 serialized UTF-8 bytes/value, 128 counted generic profile keys and 32 entries/update** unchanged. One catalogue consumes one key and one write entry. No sharding or reserved 9-MiB exception. [Current constants](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/packages/gateway-protocol/src/schema/user-profile-constants.ts) · [Current validator](https://github.com/openclaw/openclaw/blob/aa8288706247f3445242abf74395b9419100e665/src/state/user-preferences.validation.ts)

| Standalone synthetic calculation                          | Actual bytes | All flags projected false |
| --------------------------------------------------------- | -----------: | ------------------------: |
| Empty envelope                                            |           26 |                        26 |
| One representative record                                 |           96 |                        97 |
| Eight representative records                              |          609 |                       617 |
| Eight maximal ordinary ASCII / selected multibyte records |        3,097 |                     3,105 |
| Ordinary triggers with quote/backslash-heavy bodies       |        5,145 |                     5,153 |
| Worst control escaping in trigger and body                |       15,897 |                    15,905 |
| Exact proposed reserve boundary                           |        4,088 |                     4,096 |
| One byte beyond proposed reserve                          |        4,089 |                     4,097 |

The raw field caps do not guarantee aggregate fit. Every true-to-false flag change adds one serialized byte. Propose `actual compact bytes + number of true flags <= 4096`, reserving at most eight bytes and leaving actual content/flags unchanged. The ordinary maximal value has 991 bytes of headroom after the reserve. An all-false value can occupy exactly 4,096 bytes; an all-true actual 4,096-byte value projects to 4,104 and fails the proposed reserve. This is a proposed catalogue rule, not current generic Gateway behavior. [Reproducible arithmetic](checks/catalogue-size-calculation.md) · [Actual result](checks/catalogue-size-calculation.json)

Authenticated `users.prefs` is remote account-profile state, not browser-private or per-plugin isolated. Native Control UI plugins share operator Gateway authority. Generic `expectedEntries` is optional; a proposed catalogue editor could require the complete previous value through the existing owner. Expected null means absent; a null write deletes the key. Preserve unsaved text on conflict. Existing handler assertions and canonical write authority remain.

Current profile merge preserves an existing target value, can skip a source key at capacity and then deletes source preference rows. It does not guarantee both catalogues survive. Storage/access/content/merge/retention and any actual user-data migration must be accepted separately. No automatic truncation or conversion of the fork's large catalogue is proposed. [Current owner facts](checks/current-owner-facts.md)

## Shared policy, coordination and deferred scope

The shared proposal is one `UiSettings` / `UiPreferences.dictationPreparation` group through existing settings functions, with a proposed 1-KiB self-limit:

```json
{
  "version": 1,
  "literalProfile": "prose",
  "punctuation": "preserve",
  "cleanup": "off",
  "correction": "off",
  "structure": "off",
  "refinement": "off"
}
```

Allowed alternatives are prose/developer-review, preserve/review for punctuation, and off/review for other transforms. Missing values retain current prose defaults. This is browser/Gateway-scoped policy only, without bodies, transcripts, secrets or lifecycle state. Keep it outside the full sync descriptor and server `ui.prefs` schema; `configSync:false` alone can still permit profile synchronization. The field is not implemented or accepted. M05 presets patch the same fields; M07/M06/P03 content is a separate owner decision. [Current settings facts](checks/current-owner-facts.md)

Coordinate [M11 #205845](https://github.com/openclaw/openclaw/issues/205845) and [M08 #205848](https://github.com/openclaw/openclaw/issues/205848) without treating private M01–M05/M11 helpers as a public API or accepted parent. This iteration does not refresh or claim resolution of those issues. Protected snippet text must not be reinterpreted or rewritten by M02/M03/M04/M11. Semantic work uses an accepted model owner or abstains.

Defer mixed multi-intent captures, large bodies/hundreds of entries, import/export, sharing, cloud sync, new persistent catalogues, native/mobile/external targets, broader locales and unaccepted refinement integrations. Static bodies, no dynamic variables, no execution and no Send remain firm. The old 25-ms/500-entry target is outside the proposed slice and UNMEASURED.

Acceptance must record the automatic/manual choice, exact host/SDK and literal-placement contract, grammar, actual storage key/access/retention, shared policy and lifecycle behavior. A later implementation task can then reassess the existing fork. This design commit supplies none of those decisions or runtime proof. [Readiness](pr-readiness.md) · [Qualification runbook](checks/qualification-runbook.md)
