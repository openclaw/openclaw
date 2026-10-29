---
summary: "Correct, withdraw, supersede, merge, and unmerge Knowledge records while preserving originals and history"
read_when:
  - A saved Knowledge claim or relationship is wrong and needs replacing
  - Earlier Knowledge claims are replaced by a claim that already exists, such as status snapshots by their outcome
  - You need to retract a Knowledge record without deleting history
  - Two Knowledge pages turn out to describe the same person or entity
title: "Knowledge corrections and merges"
sidebarTitle: "Corrections and merges"
---

Explicit lifecycle changes for saved knowledge. Part of the
[Knowledge plugin](/plugins/knowledge) guide.

These are agent-only operations. The Control UI inspects records and history and
can hand a correction request to chat, but has no direct write controls. Ask the
agent, or use the `knowledge-correct` skill.

## Correct a claim or relationship

`knowledge_correct` takes:

- `requestId`, the exact target `id`, `expectedRevision`, `expectedHash`, and a
  nonblank `reason`;
- the current `expectedOntologyFingerprint` and an optional `expectedVaultId`;
- a complete `replacement` of the same kind: `{kind: "claim", ...}` or
  `{kind: "relationship", ...}`, validated like a create.

The target must be a valid active (or expired) claim or explicit relationship.
The replacement cannot depend on the original or its dependents. New evidence
never supersedes anything automatically.

The original keeps its content and evidence and gets a new revision with
`lifecycle: superseded`, `superseded_by`, and `lifecycle_change: {reason, at,
actor, request_id}`. The replacement is a new record at revision 1 with
`supersedes`. Both changes publish in one journal entry with one receipt.

Pages are not corrected this way. Edit page prose with a revision-fenced
`knowledge_save_page` or `knowledge_edit_body`.

## Withdraw a record

`knowledge_withdraw` takes `requestId`, `id`, `expectedRevision`,
`expectedHash`, `reason`, and an optional `expectedVaultId`. It retracts one
page, claim, or explicit relationship, including a superseded record or one with
validation findings. Withdrawing one relationship never withdraws others with the
same endpoints. A withdrawn record rejects new withdrawal requests; the original
request stays retryable.

Withdrawal is not erasure. Originals, evidence, history, Git, exports, and
backups keep their content. There is no unwithdraw.

## Supersede claims by an existing claim

`knowledge_correct` writes a new replacement. When the replacement already
exists, for example a series of CI and review snapshots about one PR followed by
the claim that it merged, use `knowledge_supersede` instead so no duplicate is
written:

- `knowledge_supersede` takes `requestId`, a nonblank `reason`, an optional
  `expectedVaultId`, `by: {id, expectedRevision, expectedHash}` (the claim that
  replaces them), and `superseded`: 1 to 25 `{id, expectedRevision,
  expectedHash}` fences of the earlier claims.
- `by` must be a current claim in the caller's scope: active, not expired, and
  not hidden by an unavailable dependency. Each earlier claim must be an active
  claim, listed once, other than `by`, and share at least one linked page
  (`entities` or source page, merge redirects followed) with `by`, as a check
  that both are about the same subject. Link them first with
  `knowledge_annotate`.
- Each earlier claim keeps its text, evidence, attribution, and history and gets
  a new revision with `lifecycle: superseded`, `superseded_by`, and
  `lifecycle_change`, exactly like a corrected original. `by` is not
  rewritten. All changes publish in one journal entry. The receipt has
  `operation: "supersede"`, `replacementId`, the dependents in `impact`, and
  one `items` entry with the new revision and hash per superseded claim.
- Because `by` must be current and every earlier claim active, supersession
  cannot form a cycle, and a superseded claim keeps its first replacement.

To undo a supersession, call `knowledge_supersede` again with `undo: true`, the
same `by`, and the superseded claims' current fences (from the receipt's
`items` or `knowledge_record`). Each claim becomes active again without
`superseded_by`; its `lifecycle_change` records the undo reason. The receipt has
`operation: "unsupersede"`. Undo applies only to supersessions this tool made:
a claim replaced by `knowledge_correct` is rejected, since its replacement is a
new version of it. Correct or withdraw that replacement instead.

## Impact and visibility

Correction, withdrawal, and supersession receipts include `operation`,
`targetId`, `replacementId` (for corrections and supersessions), `reason`, and
`impact`. `impact.items` lists authorized direct and
transitive dependents through `dependencies`, `entities`, `owner`, and
relationship endpoints. These are unresolved impacts, not automatic repairs.
Nothing rewrites prose copies, cascades, or deletes. Follow up by inspecting and
repairing records, or report them unresolved.

Default lookup, search, connections, records, and status counts use current
eligibility, so inactive records and their dependents are excluded before
counting. `knowledge_records({lifecycle: "all"})` lists historical records,
and exact record and history reads stay available. Historical lookup and search
include superseded records, never withdrawn ones. A page hidden by an inactive
dependency can still be edited by exact ID to repair it.

## Recovery and safeguards

Repeat the exact request and payload after a lost response, or resume the
accepted request with `knowledge_resume`. A changed payload under the same ID is
rejected. Conflicts keep the proposed, original, and displaced material and block
reads until reviewed; resume never overwrites a conflicting edit.

Durable guards in `state.sqlite` record withdrawals and supersessions per store
and partition. A restored or stale active Markdown file cannot clear them, and
withdrawal outranks supersession. Only a published `knowledge_supersede` undo
lifts a supersession guard, for the claims it restores. Back these tables up with the rest of
`state.sqlite`: restoring only Markdown or Git cannot rebuild a guard for a
record that is no longer present.

## Merge duplicate pages

When two pages of the same type are confirmed to be one entity (the user said so
or a source states it), merge them instead of correcting each claim:

- `knowledge_merge` takes `requestId`, `reason`, `survivor: {id,
  expectedRevision, expectedHash}`, `absorbed: {id, expectedRevision,
  expectedHash}`, and optional `title`, `body`, and identity `evidence`.
- The absorbed page stays on disk with `lifecycle: merged` and `merged_into`.
  Records that name it are not rewritten; every read resolves the reference to
  the survivor.
- The survivor gains the absorbed title and aliases, tags, evidence, and fields
  it lacks. Its own field values win; conflicts are reported. Bodies are never
  merged automatically; supply `body` to write a combined one.
- New writes that reference a merged page are rejected with the survivor's ID.
- Chains resolve up to 8 hops to an active page. Cycles, dead ends, and longer
  chains are invalid, and records that name them are hidden.

`knowledge_unmerge` restores the merged page and removes what the merge added to
the survivor, keeping values edited since. A body or title written during the
merge is not reverted.

`knowledge_diagnostics` reports `mergeCandidates`: pages of one type that share a
namespaced identity alias such as `discord:<id>` or `email:<address>` (strong) or
an exact normalized title (weak). Confirm identity before merging; never merge on
name similarity alone. Automatic merging, merging claims or relationships, and
merging across types are not supported.
