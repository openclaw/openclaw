# M07 PR readiness

## NOT READY FOR IMPLEMENTATION

**Design handoff: DONE. Implementation: PLAN ONLY. Acceptance: NEEDS MAINTAINER. Product proof: NOT COLLECTED. Runtime targets: UNMEASURED.**

The user authorized committing requested revisions without commenting. The current [ClawSweeper feedback](https://github.com/openclaw/openclaw/issues/205639#issuecomment-7178316740) requests design/owner decisions before implementation, so this revision adds design files to the existing fork branch. It does not create another implementation or PR.

## Concrete decisions still needed

| Decision | Required record | Status | Product proof |
| --- | --- | --- | --- |
| Automatic versus manual milestone | Accepted option, browser/en-US scope, exact explicit grammar and unknown/ambiguous/escape behavior | NEEDS MAINTAINER | NOT COLLECTED |
| Composer/SDK contract | Exact narrow API/version/export, finalized-source/capture/draft/target metadata, range units, ordered review and conflict outcome | NEEDS MAINTAINER | NOT COLLECTED |
| Literal placement and Undo | Existing owner preserves the entire body or visibly refuses capacity/encoding; one real Undo operation and no Send; no reuse of truncating prose path as proof | NEEDS MAINTAINER | NOT COLLECTED |
| Content storage and access | Actual key/owner, content policy, native-plugin/shared profile exposure, whole-value validation and optional disable reserve | NEEDS MAINTAINER | NOT COLLECTED |
| Concurrency and retention | Complete prior-value expectedEntries convention, conflict/deletion/profile merge, backup/retention, actual fork-data preservation/migration if any | NEEDS MAINTAINER | NOT COLLECTED |
| Lifecycle and shared policy | One feature snapshot, true new-request admission, actual authority/correctness/cancel/Stop/FIFO; local policy/sync exclusions and M11/M08 coordination | NEEDS MAINTAINER | NOT COLLECTED |
| Later execution and real hardware | Accepted task plus permitted source isolation; required approval for credentialed/trusted-host execution; actual microphone/provider/Gateway/browser/AT | NEEDS MAINTAINER for execution; NEEDS USER for actual access/hardware | NOT COLLECTED |

These decisions do not block committing the requested design revision. They block claiming that its product behavior has been implemented or accepted.

## Existing fork comparison

Observed [CompleteDotTech/openclaw#2](https://github.com/CompleteDotTech/openclaw/pull/2) is open/draft, head `7d8c99e9683ab86d65452d3de71ed3aa8463e6cc`, base `b7bd237d00508e0999c7a3fc6e36bc32bf421098`, in the same fork. The commit for this revision is based on that head and keeps runtime source unchanged. No durable PR review or reviewed PR SHA is established by the refreshed empty inventories.

| Existing fork proposal | Accepted later work would need to resolve |
| --- | --- |
| Reserved dictation.snippets, 500 total records, 16-KiB bodies and 9-MiB exception | Replace only under accepted implementation scope; do not treat the exception as existing platform permission. Protect actual data before reduction. |
| Custom revision/privacy/merge behavior and import/export UI | Decide content ownership, access, retention and full-value concurrency. Import/export and larger storage remain deferred. |
| Private review/refinement integration and broad generation/auth checks | Accepted host seam with existing order/task/editor owner, no private prototype promoted silently, no unjustified feature rechecks, existing transport/correctness retained. |
| Historical test/build/benchmark counts | Attribute to their original fork source. Fresh automatic mic/provider/browser/AT/sibling/compatibility proof remains missing. |

The source/current-policy comparison is in [decision-brief.md](decision-brief.md) and [current-owner-facts.md](checks/current-owner-facts.md). Do not remove, reset or rewrite existing implementation commits in this documentation task.

## Narrow proposed future diff boundaries

| Responsibility | Existing owner / permitted later boundary |
| --- | --- |
| Finalized capture | composer-dictation.ts and composer-dictation-session.ts; retain session/order facts and authorized final drain |
| Public capability | Accepted narrow Control UI SDK type/subpath/version and required documentation/registry changes, not a convenience barrel or private prototype export |
| Optional consumer | Actual plugin location remains unselected; deterministic exact static resolution and inert candidate only |
| Review/input/Undo | Existing composer task and actual editor; explicit draft conflict and full-body capacity behavior; no duplicate queue/history |
| Content persistence | Existing authenticated users.prefs owner only if accepted; preserve generic 4096/128/32 limits and actual authority; separate material retention changes |
| Shared policy | Existing settings load/save/default/validation owner, with explicit exclusion from all sync descriptors and strict server ui.prefs; no content in policy |
| Siblings | Accepted M02/M03/M04/M11 protected-literal contract with M08 coordination, or abstain/defer; no new coordinator/model runner |
| Verification | Actual owner tests/callers selected from accepted files; real loaded UI and consumer proof, not invented test paths |

Current prose placement's maxLength/truncateUtf16Safe behavior must be included in capacity and regression coverage. Preserve normal prose behavior while proving the accepted literal path cannot silently shorten snippets.

## Proposed later PR title/body outline

Conditional automatic title: **feat(control-ui): add a reviewed dictation hook for tiny static snippets**.

Conditional manual title: **feat(control-ui): add a reviewed manual snippet action**.

The later body should state the user problem, actual accepted automatic/manual scope and owner decision links, resulting review/Apply/Undo behavior, exact storage/access/retention and deferred scope, admission/authority/Stop behavior, source/base/head, actual focused command results, served build identity, real client/provider/AT and compatibility evidence, and every remaining gap. Use `Related: https://github.com/openclaw/openclaw/issues/205639`; do not close unmet criteria or sibling issues by inference. This outline is not posted by the design commit.

## Later implementation sequence

1. Record actual owner decisions above. A bot recommendation, draft implementation or complete document is not acceptance.
2. Under a later accepted implementation task, inspect the existing proposal and any real authored data; preserve prior work and reuse/amend the accepted approach without a duplicate implementation. Do not invent a shipped migration contract from main/fork code.
3. Establish permitted execution placement. Untrusted fork source, install hooks and wrappers require secretless isolation; a worktree alone is insufficient. Credentialed live proof needs required approval and task-scoped access. No project code runs in this revision.
4. Refresh the accepted head, applicable guidance and actual changed files. Follow Solid/storage/SDK owner rules when those paths are actually touched. Avoid new queues, authorization services or speculative metadata.
5. In the permitted future environment, use `pnpm changed:lanes --json` and the correct accepted range to select exact focused tests/type/lint/format. The verified existing regression path is `ui/src/pages/chat/composer-dictation.test.ts`; no feature-specific test path is invented before implementation. Use repository wrappers, serial execution or distinct Vitest cache paths.
6. Build applicable boundaries and `pnpm ui:build`; verify the real Gateway serves the changed `dist/control-ui` asset before observing behavior. No stale build/dev server/mock result can prove the required live flow.
7. Execute Q01–Q16 in [qualification-runbook.md](checks/qualification-runbook.md), including whole-value/field/disable capacity, whole-literal insertion refusal, snapshot races, real authority, Stop/FIFO, AT and sibling behavior. Record exact-head failures/gaps honestly.
8. Verify latest stable at execution time and run a real supported upgrade with unrelated preferences. Any accepted persistence change needs the documented binary rollback/downgrade/retention proof; do not assume deferred export as recovery.
9. Complete only required gates and named risks. A later commit does not itself authorize comments, hosted re-review, workflow dispatch, a new PR or merge. Keep the user's no-comment instruction unless separately changed.

The current design, metadata, arithmetic and document checks are reviewable and commit-authorized. Product source changes and all runtime qualification remain pending.
