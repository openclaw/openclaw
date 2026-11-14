---
name: knowledge-correct
description: Correct or withdraw specific saved Knowledge claims, explicit relationships, or pages at the user's request, preserving provenance and inspecting affected knowledge. Use for “that's wrong”, “retract that”, or a Knowledge chat reference; not automatic contradiction resolution or physical erasure.
---

# Correct saved knowledge through agent tools

Read [shared conventions](references/conventions.md) and
[publication](references/publication.md) before writes.

## Identify the owning record

Use a supplied structured record/claim ID and revision as the primary target,
not just its display label. Read `knowledge_record` with metadata and evidence;
confirm its current revision/hash. A referenced revision that changed requires
rereading and reconciling the request, not silently acting on a new assertion.
Without an exact reference, use lookup/search, inspect candidates, and ask only
when the requested target or correction remains materially ambiguous.

Distinguish an erroneous saved assertion from an unsupported answer, conflicting
source statements, and a fact that changed over time. Contradiction alone does
not authorize supersession; the one non-user case is a standing statement its own
holder explicitly replaced, per publication. Do not manufacture a stored “guard fact” when no
record exists or treat a retraction as evidence for its opposite.

## Apply the right operation

- **Claim or explicit relationship correction:** call `knowledge_correct` with
  the exact ID, observed `expectedRevision` and `expectedHash`, reason, observed
  vault UUID and ontology fingerprint, and a complete `replacement` of the same
  `kind`. Replacement fields use the create-claim/create-relationship contract;
  there is one outer request ID, not a second replacement request. Preserve
  supported context, attribution, precise dates and evidence; remove or revise
  what the correction actually changes. The operation publishes the replacement
  and supersedes the old assertion together, with links in both directions.
- **Replaced by a claim that already exists:** call `knowledge_supersede` with
  the existing claim as `by` and the earlier claims' fences in `superseded`
  instead of correcting, which would write a duplicate of the replacement. The
  claims must share a linked page. Undo a mistaken supersession with the same
  call and `undo: true`.
- **Withdrawal without a replacement:** call `knowledge_withdraw` with the
  exact ID, revision/hash, reason and vault UUID. It accepts pages, claims and
  explicit relationships. An edge is identified by its own ID, not its endpoint
  pair. It preserves original evidence/history and is not file deletion.
- **Page prose correction:** use ordinary revision-fenced `knowledge_save_page`,
  preserving unrelated authored material and sources. Page corrections are
  revisions, not replacement entity identities.
- **Two pages for one entity:** call `knowledge_merge` with the surviving page,
  the duplicate, both pages' current revision/hash and a reason. Keep the page
  with the fuller identity (real name, more connections) as the survivor; pass
  `title` to rename it and `body` when the combined page should say more than
  the survivor's current prose. The duplicate's ID, title, aliases, claims,
  relationships and links then resolve to the survivor; nothing is corrected one
  by one. Undo a mistaken merge with `knowledge_unmerge`.

An explicit user correction can supply evidence: retain their exact statement
with `knowledge_attach`, attribute it to the user, and reference its verified
locator. Use `assertion_origin: user_belief` to distinguish a user assertion from
an independently sourced statement; do not claim documentary verification.
Agent inference still needs retained premise evidence, not an invented quote.

## Resolve a handle or mistaken identity

Use `knowledge-entities` to find and read the handle profile, the established
person and their connected records. Retain the user's exact identification as
evidence. Update supported aliases and identity context on the existing pages;
preserve unrelated content and describe the connection to the established person.
Use that person's existing ID for future enrichment. When the handle already has
its own page, merge it into the established person's page with `knowledge_merge`
instead of writing a pointer page, withdrawing it, or correcting its claims one by
one. Merge only on identity evidence (the user's statement, a self-introduction, a
shared stable account ID), never on name similarity; `knowledge_diagnostics`
`mergeCandidates` lists pages to check, not pages to merge. Retain the identity
evidence with `knowledge_attach` and pass it as `evidence`.

Inspect affected prose, claims and relationships, including source notes, within the correction
scope. Correct mistaken attribution and unresolved identity where the new evidence
supports it, using the page/assertion operations above; preserve source labels,
verbatim quotes, event dates and correction provenance. A confirmed author identity
does not independently verify that author's factual claims.

Changes go through these tools, not manual Markdown edits, browser forms, SQL,
or separate “create then withdraw” calls. No additional approval ritual applies
to an unambiguous user-authorized correction. Follow publication retry/conflict
handling; a receipt in accepted/conflict state is not a completed repair.

## Inspect propagation and report honestly

The receipt's `impact.items` identifies known scoped direct/transitive dependents
at acceptance. It does not update them. Read affected records by exact ID and
inspect their evidence. Repair only supported changes within the request's scope;
do not blindly replace dependency IDs or source quotes with the new claim.
Records depending on an inactive assertion are withheld from current discovery
until repaired; exact record/history inspection remains available.

Search for plausible prose copies as a supplementary check. Search misses,
unlinked prose, hidden scopes and incomplete indexes prevent a universal “all
copies fixed” promise. Do not alter unrelated memory or identity systems as an
automatic consequence of a Knowledge correction.

Read back the original and replacement (or withdrawn target), verify lifecycle
and evidence, and verify current lookup excludes the old assertion. Reply with
the receipt/request ID, affected record IDs, the correction/retraction reason,
and repaired versus unresolved dependencies. Mention retained history only when
relevant; never promise erasure from originals, exports or backups.
