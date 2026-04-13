WORK LOG

Add your findings and worklogs by appending to the end of this file. Do not overwrite anything that is existing in this file. Write with the format being used.

[CODEX]

I've brought work into the workstream.

[CLAUDE]

I've assigned the work to eleqtrizit.

[CODEX SECURITY FIXER]

- Reviewed NVIDIA-dev/openclaw-tracking#434, GHSA-jwrq-8g5x-5fhm, related advisories GHSA-wpg9-4g4v-f9rc and GHSA-g5cg-8x5w-7jpm, and SECURITY.md.
- Determined the issue is in scope: collect-mode batching collapses the documented owner-only/per-sender authorization boundary in shared group queues.
- Determined a compatible hardening path exists: split collect-mode batches on authorization-context changes while preserving in-order batching for matching contexts.
- Reviewed existing GHSA-private draft PR openclaw/openclaw-ghsa-jwrq-8g5x-5fhm#1 and incorporated the approach with tighter handling for exec defaults and queue order; preserved co-author credit for zsx <git@zsxsoft.com>.
- Implemented the fix on branch `ag/collect-batch-context` and opened PR https://github.com/openclaw/openclaw/pull/66024.
- Added regression coverage for mixed owner/non-owner batches, matching-context batches, exec-context splits, repeated auth flips, and authorization-key changes.
- Validation run:
  - `pnpm test src/auto-reply/reply/queue.collect.test.ts`
  - `pnpm test src/auto-reply/reply/queue.dedupe.test.ts`
  - `pnpm test src/auto-reply/reply/queue.drain-restart.test.ts`
  - `claude -p "/review"` (addressed feedback by adding an explicit same-context regression test)
- `pnpm tsgo` currently reports unrelated pre-existing failures on latest `origin/main` in `extensions/discord`, `extensions/feishu`, `extensions/nextcloud-talk`, `extensions/whatsapp`, `src/cron`, and `src/wizard`.
- Posted PR link back to the tracking issue: https://github.com/NVIDIA-dev/openclaw-tracking/issues/434#issuecomment-4237703603

[CLAUDE REVIEW]

## Review of branch `ag/collect-batch-context` — 2026-04-13

### Tracking Issue

NVIDIA-dev/openclaw-tracking#434 (GHSA-jwrq-8g5x-5fhm, severity: medium)

### Goal

The branch fixes a security vulnerability in the collect-mode queue drain logic (`src/auto-reply/reply/queue/drain.ts`). In the default "collect" queue mode, all messages that arrive while the agent is busy are batched together and processed under a single `run` object — specifically `items.at(-1)?.run`, i.e. the **last sender's** authorization context. In a group chat where users have different authorization levels (owner vs. non-owner), this means:

- A non-owner's message can be processed with `senderIsOwner=true` if an owner's message arrives later in the same batch window.
- Per-sender tool restrictions (`toolsBySender`) are resolved against the wrong sender's identity fields.
- `bashElevated` and `execOverrides` from the last sender are applied to all messages in the batch.

The authorization confusion is order-dependent and transient (per batch cycle), but requires only standard group-chat usage to trigger — no special operator config or adversarial setup needed.

### What the fix does

**Commit 1 (`50c59b1`):** `fix(queue): split collect batches by auth context`

Introduces three new functions:

1. **`resolveFollowupAuthorizationKey(run)`** — Computes a deterministic key from all security-relevant fields on `run`: `senderId`, `senderName`, `senderUsername`, `senderE164`, `senderIsOwner`, plus `execOverrides` sub-fields (`host`, `security`, `ask`, `node`) and `bashElevated` sub-fields (`enabled`, `allowed`, `defaultLevel`). Uses `JSON.stringify` over a fixed-order array for comparison.

2. **`splitCollectItemsByAuthorization(items)`** — Partitions queue items into contiguous groups where the authorization key is identical. Adjacent grouping (not deduplication): if messages arrive A→B→A, this produces 3 groups, preserving chronological message order and preventing cross-sender reordering.

3. **`renderCollectItem(item, idx)`** — Adds per-message sender attribution (`(from SenderName)`) to the collected prompt so the model can distinguish message authorship within a batch.

The drain loop is then changed from processing one batch with `items.at(-1)?.run` to iterating over auth groups, each using `groupItems[0]?.run` as its authorization context.

**Commit 2 (`f71c702`):** `fix(queue): keep overflow summary on splits`

A follow-up fix: changes the overflow summary from being attached only to the first auth group (`groupIdx === 0 ? summary : undefined`) to being included in every auth group's prompt. This ensures all split batches have visibility into queue overflow state rather than only the first one.

### Test coverage added

Five new integration tests in `src/auto-reply/reply/queue.collect.test.ts`:

| Test                                                                | What it validates                                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `splits collect batches when sender authorization changes`          | Non-owner + owner → 2 separate followup calls, each with correct `senderIsOwner` and isolated prompts |
| `keeps one collect batch when authorization context matches`        | Same sender × 2 → 1 followup call (no unnecessary splitting)                                          |
| `splits collect batches when exec context changes`                  | Same owner but different `bashElevated`/`execOverrides` → 2 calls with correct exec context on each   |
| `preserves collect order when authorization changes more than once` | A→B→A pattern → 3 calls in order (no merging of non-adjacent same-auth items)                         |
| `resolveFollowupAuthorizationKey` unit tests                        | Key changes when `senderIsOwner` flips; key changes when exec defaults change                         |

### Best practices and standards assessment

**Positive:**

- **Directly addresses the root cause.** The fix splits at the authorization boundary rather than applying a heuristic like "most restrictive context." This is the correct approach given that `toolsBySender` policies are not totally ordered and cannot be safely merged.
- **Minimal blast radius.** Only `drain.ts` production code is touched (90 lines changed). No unrelated refactors bundled in.
- **Conservative batching preserved.** Messages from the same sender with the same auth context are still collected — the fix only splits where it must.
- **Test coverage is thorough and targeted.** Tests validate the core vulnerability scenario (mixed owner/non-owner), the happy path (no unnecessary splitting), exec-context edge cases, and ordering preservation under repeated auth flips.
- **Sender attribution in prompts.** Adding `(from SenderName)` to `renderCollectItem` gives the model visibility into who authored each queued message, reducing cross-sender instruction-following risk even within a correctly-scoped auth batch.
- **Export and direct unit testing of `resolveFollowupAuthorizationKey`.** The key computation is tested in isolation, not just through integration. Good for regression confidence.
- **No lint suppressions, no `any`, no `@ts-nocheck`.** Clean TypeScript.
- **Commit structure.** Two focused, well-scoped commits with clear conventional-commit messages. The second commit is a genuine follow-up fix, not cleanup noise.

**Observations and minor concerns:**

1. **Auth key field coverage.** The key covers `senderId`, `senderName`, `senderUsername`, `senderE164`, `senderIsOwner`, `execOverrides.*`, and `bashElevated.*`. Fields **not** in the key include `authProfileId`, `elevatedLevel`, `ownerNumbers`, and `config`. For the specific vulnerability being fixed (tool authorization via `applyOwnerOnlyToolPolicy` + `resolveToolsBySender` + exec context), the coverage is correct — the omitted fields are either invariant per-session or not consulted in the downstream authorization decisions. However, if new authorization-relevant fields are added to `run` in the future, the key must be updated. A brief code comment on `resolveFollowupAuthorizationKey` noting this would be a low-cost improvement.

2. **Overflow summary repetition.** After commit 2, every auth group receives the overflow summary string. For a batch split into 3 groups, the model sees the same overflow note 3 times across 3 separate followup calls. This is functionally correct (each call is independent and needs context), but slightly redundant from the model's perspective. Not a bug — just a tradeoff worth noting.

3. **Error/retry semantics.** `queue.items.splice(0, items.length)` happens after all auth groups are processed. If `effectiveRunFollowup` throws partway through the loop (e.g., group 1 succeeds, group 2 fails), the catch block fires, `queue.draining` is reset, and the **entire** original item set is retried (including group 1's already-processed items). This is the **same behavior as before the fix** — it is not a regression — but it means messages could be double-delivered on partial failure. A future improvement could track which groups completed and splice more granularly.

4. **`JSON.stringify` for key comparison.** Fine for same-process, same-turn comparison. If keys ever needed to be compared across processes or serialized, a hash would be more appropriate. Current usage is correct.

5. **Adjacent grouping is the right choice.** The A→B→A → 3-group behavior is correct for security. Merging non-adjacent same-auth items would reorder messages across sender boundaries, which could change conversational meaning. The test explicitly validates this.

### Verdict

The fix is well-implemented, directly addresses the vulnerability described in GHSA-jwrq-8g5x-5fhm, follows repo coding standards, and has strong regression test coverage. The approach (split by auth context, not merge to most-restrictive) is the correct one given the `toolsBySender` semantics. No blocking issues found. Minor suggestions above (auth key comment, partial-failure granularity) are future improvements, not blockers.

[CLAUDE PLAN]

## Fix plan for PR #66024 review findings — 2026-04-13

### Sources reviewed

- NVIDIA-dev/openclaw-tracking#434 issue body + triage comment (drobison00)
- PR openclaw/openclaw#66024 comments: Greptile (1 inline), Codex (4 inline across 2 review rounds), 1 issue-comment from eleqtrizit
- CLAUDE REVIEW section above (5 observations)

### Issue 1 (P1 — Regression): Partial failure causes duplicate delivery of already-sent auth groups

**Source:** Codex inline review (both commit 1 and commit 2 reviews, `discussion_r3074150975` and `discussion_r3074188986`), CLAUDE REVIEW observation #3.

**Problem:** `queue.items.splice(0, items.length)` at `src/auto-reply/reply/queue/drain.ts:194` runs after the entire auth-group `for` loop. If `effectiveRunFollowup` succeeds for group N but throws for group N+1, the catch block at line 230 fires, `queue.draining` resets in the finally block, and `scheduleFollowupDrain` re-enters — reprocessing ALL items including already-delivered group N. `effectiveRunFollowup` is not idempotent (generates a fresh UUID per call in `followup-runner.ts`), so this produces duplicate replies and duplicate tool side effects.

**Is this a new regression or pre-existing?** NEW. The old single-batch code was atomic: one `effectiveRunFollowup` call then one splice. The multi-group loop broke this atomicity. Non-collect modes use `drainNextQueueItem` (in `src/utils/queue-helpers.ts:147-158`) which splices immediately after each successful run — the collect auth-group loop should follow the same pattern.

**Not part of a larger hidden problem.** The `drainCollectQueueStep` early-return path (cross-channel items) already goes through `drainNextQueueItem` and splices per-item. The inbound dedupe mechanism (`claimInboundDedupe` in dispatch) operates at the dispatch layer, not the queue layer, so it does not protect against queue-level re-delivery.

**Fix (in `src/auto-reply/reply/queue/drain.ts`):**

1. Track a running splice offset (e.g., `let spliced = 0`).
2. After each successful `await effectiveRunFollowup(...)` call inside the auth-group loop, immediately splice that group's items from `queue.items`: `queue.items.splice(0, groupItems.length)` and increment the offset.
3. Remove the bulk `queue.items.splice(0, items.length)` at line 194 — it becomes a no-op since items are already spliced.
4. Move the `clearQueueSummaryState(queue)` call to after the loop (it can stay where it is, gated on `summary`).

**Test to add (in `src/auto-reply/reply/queue.collect.test.ts`):**

- Enqueue items with 2 different auth contexts (non-owner + owner).
- Have `runFollowup` throw on the 2nd call (first auth group), then succeed on retry.
- Assert group 1's messages appear exactly once across all `calls` (not duplicated).
- Assert group 2's messages are delivered on the retry.

### Issue 2 (P2 — Behavioral regression): Use newest `run` in each auth group, not oldest

**Source:** Codex inline review (both commit 1 and commit 2 reviews, `discussion_r3074150979` and `discussion_r3074188994`).

**Problem:** `drain.ts:175` uses `groupItems[0]?.run` (oldest item in the group). The original pre-fix code used `items.at(-1)?.run` (newest). Within a same-auth group, all items share the same authorization key, but non-auth fields on `run` can differ: `provider`, `model`, `config`, `verboseLevel`, `thinkLevel`, `reasoningLevel`, `skillsSnapshot`. If a user changes their preferred model while the agent is busy, the batch executes with stale provider/model settings from the oldest message instead of the latest.

**Is this a new regression?** YES. The old code always selected the latest run's runtime context.

**Not part of a larger hidden problem.** The auth-key grouping invariant guarantees all security-relevant fields are identical within a group. Only non-auth runtime fields (model, provider, config) can differ, and using the newest run is strictly better for freshness — it matches the pre-fix behavior.

**Fix (in `src/auto-reply/reply/queue/drain.ts:175`):**

- Change `groupItems[0]?.run` to `groupItems.at(-1)?.run`.

**Test consideration:** The existing tests don't assert non-auth runtime fields within same-auth groups. Optionally add a test where two same-sender items differ in a non-auth field (e.g., pass different `provider` values on the run) and assert the latest item's value is used.

### Issue 3 (ALREADY FIXED): Overflow summary suppressed for non-first auth groups

**Source:** Greptile inline review on commit 1 (`discussion_r3074152894`).

**Status:** Fixed in commit 2 (`f71c702`). Current code at line 184 passes `summary` unconditionally to all auth groups. No action needed.

### Issue 4 (Minor — Hardening): Auth key field coverage comment

**Source:** CLAUDE REVIEW observation #1.

**Problem:** `resolveFollowupAuthorizationKey` intentionally excludes `authProfileId`, `elevatedLevel`, `ownerNumbers`, and `config` because they are either invariant per-session or not consulted in downstream authorization decisions (`applyOwnerOnlyToolPolicy`, `resolveToolsBySender`). However, if future code adds new auth-relevant fields to `run`, the key must be updated. No code comment documents this design decision.

**Not part of a larger hidden problem.** The excluded fields were verified against the downstream consumers in `pi-tools.ts:634-635` and `tool-policy.ts:55-66`. They do not currently influence per-message authorization.

**Fix (in `src/auto-reply/reply/queue/drain.ts`, above `resolveFollowupAuthorizationKey`):**

- Add a brief comment: `// Key covers fields consulted by applyOwnerOnlyToolPolicy, resolveToolsBySender, and exec-context propagation. Fields like authProfileId, elevatedLevel, ownerNumbers, and config are intentionally excluded (invariant per-session or not consulted in per-message auth). Update this key if new auth-relevant fields are added to run.`

### Execution order

1. Fix Issue 2 first (one-line change, `groupItems[0]` → `groupItems.at(-1)`).
2. Fix Issue 1 (incremental splice + new test).
3. Add Issue 4 comment.
4. Run scoped tests: `pnpm test src/auto-reply/reply/queue.collect.test.ts`.
5. Run broader queue tests: `pnpm test src/auto-reply/reply/queue`.
6. Run `pnpm tsgo` to verify no type regressions from the changes.

[CODEX SUMMARY]

- Reviewed `USER.md`, verified Claude's plan against the current branch, and checked NVIDIA-dev/openclaw-tracking#434 for issue context.
- Confirmed both open review findings were still real in `src/auto-reply/reply/queue/drain.ts`:
  - collect-mode auth groups were using the oldest `run` in each group instead of the newest one, which regressed provider/model/runtime-context freshness within same-auth batches.
  - collect-mode auth groups were only removed from `queue.items` after the full loop, which could duplicate already-processed groups if a later group failed and the drain retried.
- Updated `src/auto-reply/reply/queue/drain.ts` to use `groupItems.at(-1)?.run`, splice each auth group immediately after a successful `effectiveRunFollowup(...)`, and added a comment documenting the intentional auth-key field coverage.
- Added regression tests in `src/auto-reply/reply/queue.collect.test.ts` for:
  - newest-run selection inside a matching authorization batch
  - retrying only the remaining auth groups after a partial collect-mode failure
- Validation:
  - `corepack pnpm test src/auto-reply/reply/queue.collect.test.ts` ✅
  - `corepack pnpm test src/auto-reply/reply/queue` ✅
  - `corepack pnpm tsgo` ❌ with pre-existing unrelated failures in `extensions/discord`, `extensions/feishu`, `extensions/nextcloud-talk`, `extensions/whatsapp`, `src/cron`, and `src/wizard`; no new queue-related type failures were introduced by this work.

[CODEX]

- Re-read `USER.md`, pulled NVIDIA-dev/openclaw-tracking#434 with `gh issue view`, and checked open review threads on openclaw/openclaw#66024 before mutating GitHub state.
- Verified the two still-open Codex findings were only fixed locally, not yet on the PR head, so resolving them immediately would have been premature.
- Re-ran the scoped queue validation after the local follow-up fixes:
  - `corepack pnpm test src/auto-reply/reply/queue.collect.test.ts` ✅
  - `corepack pnpm test src/auto-reply/reply/queue` ✅
- Prepared the branch for a scoped follow-up commit covering:
  - newest-run selection per auth group in `src/auto-reply/reply/queue/drain.ts`
  - per-group dequeue on successful collect sends to avoid duplicate retries
  - regression coverage in `src/auto-reply/reply/queue.collect.test.ts`
- Next step is to commit and push those fixes, then resolve the addressed PR threads and post fresh `@codex review` / `@greptile review` trigger comments.
