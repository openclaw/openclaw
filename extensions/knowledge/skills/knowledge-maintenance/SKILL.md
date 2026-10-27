---
name: knowledge-maintenance
description: Review and consolidate Knowledge claims over a chosen scope - the unlinked residue after relinking, the claims on one hub or over-budget page, or the claims about one subject since a date. File claims on their most specific subject page, create pages for substantial subjects, retire duplicates, supersede status snapshots and replaced claims by an existing claim, and fold durable outcomes into page State. Use for claim cleanup, consolidation, or the Consolidate unlinked claims scribe.
---

# Claim consolidation review

Read [shared conventions](references/conventions.md) and
[publication](references/publication.md) before writes.

Claims accumulate faster than pages are curated. `knowledge_remember` saves a
claim without a subject page when no name in it matches exactly one page, and
scheduled maintenance's `knowledge_relink` links only claims whose source page
is an entity page or whose text names exactly one page. Linked claims pile up
too: a hub page collects status snapshots, duplicates and claims that belong on
a more specific subject. This review runs one procedure over a chosen scope.
Work in this order: choose the scope, link, then duplicates, replaced claims
and snapshot series, then page prose.

## 1. Choose the scope and enumerate it

Call `knowledge_status` for the intended scope and `knowledge_ontology` for the
current fingerprint. Then enumerate exactly one starting set:

- **Unlinked residue** (the default, and the only scope of scribe runs). Run
  `knowledge_relink` without `dryRun` first so every remembered claim it can
  link is linked. Then list the residue with `knowledge_relink` `dryRun: true`,
  `include: "all"` and `limit: 10`, following `nextCursor`: every current
  claim with no linked page and no source page, whichever tool saved it. Each
  call reports at most 10 examples per outcome, so a limit of 10 returns every
  claim it examined.
- **One page**, for a hub page or a page over its size budget. List its
  current claims with `knowledge_connections` `id`, `direction: "claims"`,
  `view: "full"` and `includeCards: true`, following `nextOffset` with the
  same filters. Restart when `snapshot` changes. On a hub, group from the cards
  first and work one group at a time; do not read every claim in full up front.
- **One subject, optionally since a date.** When the subject has a page, list
  its claims with `knowledge_timeline` `entity`, `timeField: "recorded_at"`
  and `since`, following `nextOffset`. Also search for claims filed elsewhere
  or unlinked with `knowledge_grep` `kind: "claim"`, the subject's
  distinctive names (a PR number, a commit SHA, a feature name) and the same
  `since`/`timeField`. Keep only claims that are actually about the subject.

State the scope in the report. Read each claim you will change with
`knowledge_record` and `metadataView: "full"`. Its `subject_hint`, when
present, is the saver's own description of what the claim is about and the
strongest clue to its subject. Group the claims by what they are about (one
feature, PR, commit, decision thread, person or preference) before choosing
pages. Most claims make sense only next to their neighbours: a series of
status snapshots about one PR usually ends in an outcome claim.

## 2. Choose subject pages

For each group, find candidate pages with `knowledge_grep` and
`knowledge_lookup`, and read their State and Timeline. Ignore withdrawn pages and
fixture pages.

- The **primary subject** is what the claim asserts something about; list it
  first in `entities`. Add a secondary subject only when the claim also states
  something about that entity, such as the person who made the decision or the
  company whose product was configured. A passing mention is not a subject. Two
  or three subjects is usually enough.
- The primary subject is the **most specific** page the claim is about: a
  claim about one PR belongs on that PR's page, not only on the project the PR
  belongs to. The broader page stays a subject only when the claim says
  something about it, such as a project-level decision, policy or release.
- A preference or decision stated by a person belongs on that person's page.
  Do not turn one person's preference into a project or company policy.
- Match identity on evidence, not on similar names. When a claim names something
  that might be an existing page (for example a product name that could be a
  different service), confirm it from evidence such as configuration, a URL or
  the page's own aliases. If it stays uncertain, leave the claim where it is and
  report it.

Link with `knowledge_annotate` `entities`, passing the complete list (it replaces
the existing one) and the claim's current revision and hash. Assertion text,
evidence and lifecycle stay unchanged. Link a claim before you supersede it:
superseded claims cannot be relinked.

## 3. Create missing pages and relink to them

Linking every claim to the nearest existing page can bury a real subject in a
broad page's Timeline. Create a page when:

- a discrete subject (a feature, project, tool or substantial PR) has roughly
  five or more claims, or has its own design, proof and outcome history; or
- a person or organisation authored, owns or decided something in the claims,
  has no page, and has identity evidence (for example the PR author shown by
  `gh pr view`).

Do not create a page for a single mention or a one-off fix that a Timeline entry
covers. Use `knowledge_save_page` with the ontology `type`, aliases, and the
identity evidence as `source`. Person pages use `identity.status: partial` unless
the identity is fully established. Write a short State that cites the claims and
a dated Timeline. Link the new page from its parent page.

Then relink the group's claims, including the snapshots step 4 will supersede.
The new page becomes each claim's primary subject. Keep the broad page the
claims were filed on (often the hub this review started from) only for claims
that say something about it, by the rule in step 2; drop it from the rest.
Keep other existing secondary subjects that still qualify. Under the threshold,
leave the claims on their current pages.

## 4. Retire duplicates, replaced claims and snapshot series

- **Duplicate:** two claims assert the same fact, decision or preference about
  the same event. Keep the one with owner-approved recall, otherwise the earlier
  one, otherwise the one with fuller attribution. Copy any evidence the survivor
  lacks with `knowledge_annotate` `addEvidence`, then `knowledge_withdraw` the
  other with a reason that names the survivor's ID.
- **Replaced:** a later claim explicitly corrects the earlier one (for example an
  assistant correcting its own report) or decides a question the earlier claim
  left open. Supersede the earlier claim by the later one with
  `knowledge_supersede`, with a reason that says what replaced it. Do not use
  `knowledge_correct` here: it publishes a new copy of the replacement, which
  creates another duplicate.
- **Snapshot series:** several status snapshots about one specific item (the
  same PR, commit or decision thread: CI red at one head, review requested,
  CI green) followed by an outcome claim about the same item (merged, closed,
  reverted, released, decided, abandoned). Supersede every snapshot in the
  series by the outcome in one `knowledge_supersede` call (up to 25 claims).
  All of these must hold, from the claims' own text and dates:
  - every snapshot and the outcome name the same specific item, not merely the
    same project;
  - the outcome is dated after every snapshot it supersedes and states a final
    state, not another intermediate one;
  - the outcome and the snapshots share a subject page (link them first, step
    3); the tool rejects claims with no common page.
    A snapshot dated after the outcome, or one about a different head or a
    different item, stays.
- **Neither:** snapshots of different moments that no later outcome replaces
  (CI red, then CI green, with no merge yet) are history, not errors. Keep them.
  Contradiction alone does not justify a withdrawal or a supersession. When
  unsure, keep both and report the pair.

`knowledge_supersede` keeps every superseded claim's text, evidence, provenance
and history, records `superseded_by` and the reason on it, and leaves the
superseding claim unchanged. Default reads stop showing superseded claims;
historical reads (`historical: true`, `lifecycle: "all"`) and
`knowledge_history` still do. If a supersession was wrong, call it again with
`undo: true`, the same `by` claim and the fences from its receipt's `items`.

## 5. Update page prose

Linking makes the claims reachable from their pages; it does not change what a
page says. Edit a page only when the claims change its durable state: a
decision, a preference, a landed or released change, a new capability, a
resolved open question, or page text that later claims show to be wrong.

- Collapse a series of progress snapshots into its outcome. Snapshots (CI runs,
  open PRs, local commits) are at most dated Timeline entries, never State.
- Check mutable status live before writing it as current (for example
  `gh pr view` for merge state) and say when you checked. A merge is not a
  deployment, and a deployment is not proof that a given Gateway runs the code.
- When a design or decision page contradicts a later decision, add a dated
  amendment next to the original text rather than rewriting it. Mark answered
  open questions as resolved and keep the original question.
- Cite every added sentence with `[[claim-id|label]]` links to the claims.

Use `knowledge_edit_body` for section edits. Compute UTF-16 offsets from a fresh
full read, and reread the revision and hash before every edit: other sessions
edit busy pages concurrently. Prefer inserting text over replacing it. Replace a
whole State section only when all of it is stale, and keep the claim links it
already had.

## 6. Verify and report

Run `knowledge_verify` with `expectedEntities` for each linked claim and
`expectedLinks` for each new or edited page. Enumerate the scope again: new
claims may have arrived while you worked. Handle them the same way or report
them.

Report the scope, the number of claims examined, linked and relinked, pages
created, claims superseded (with the superseding claim for each series), claims
withdrawn (with the surviving claim for each), pages edited, and claims left
unchanged that you considered, with the reason for each. When running
unattended, never ask for a decision and never guess: leave uncertain
identities, uncertain duplicates, snapshot series whose outcome is not certain,
and pages you would only create on a guess untouched, and list them in the
report for a person.

## Scribe runs

The **Consolidate unlinked claims** scribe runs this review unattended over the
unlinked residue, on the schedule in its prompt. Its prompt checks access and
sets up its automation; this section is only the work of one run.

- Run step 1 for the unlinked residue. When the residue is empty, stop there
  and report zero claims examined.
- Otherwise work through steps 2 to 6, and check the residue again before
  stopping, since claims saved during the run are part of the same backlog.
- Do not ask questions. Give the step 6 report; the closing status line counts
  claims examined, linked, superseded, withdrawn and left.
