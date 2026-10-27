---
name: knowledge-unlinked-claims
description: Review remembered Knowledge claims still unlinked after deterministic relinking. Assign subject pages, create pages for substantial missing subjects, retire exact duplicates and explicitly replaced claims, and fold durable outcomes into page State. Use for unlinked-claim cleanup or the Review unlinked claims scribe that follows Knowledge maintenance.
---

# Review unlinked claims

Read [shared conventions](references/conventions.md) and
[publication](references/publication.md) before writes.

`knowledge_remember` saves a claim without a subject page when no name in it
matches exactly one page. Scheduled maintenance then runs `knowledge_relink`,
which links only claims whose recorded source page is an entity page or whose
text names exactly one page. The rest stay unlinked and are invisible from the
pages they concern. This skill handles that residue with judgment. Work in
this order: link, then duplicates and replaced claims, then page prose.

## 1. Enumerate the residue

Call `knowledge_status` for the intended scope and `knowledge_ontology` for the
current fingerprint. Run `knowledge_relink` without `dryRun` first so every
remembered claim it can link is linked. Then list the residue with
`knowledge_relink` `dryRun: true`, `include: "all"` and `limit: 10`, following
`nextCursor`: every current claim with no linked page and no source page,
whichever tool saved it. Each call reports at most 10 examples per outcome, so a
limit of 10 returns every claim it examined.

Read each claim with `knowledge_record` and `metadataView: "full"`. Its
`subject_hint`, when present, is the saver's own description of what the claim
is about and the strongest clue to its subject. Group the claims by what they are about
(one feature, PR, decision thread, person or preference) before choosing pages.
Most claims make sense only next to their neighbours: a series of status
snapshots about one PR usually ends in an outcome claim.

## 2. Choose subject pages

For each group, find candidate pages with `knowledge_grep` and
`knowledge_lookup`, and read their State and Timeline. Ignore withdrawn pages and
fixture pages.

- The **primary subject** is what the claim asserts something about. Add a
  secondary subject only when the claim also states something about that entity,
  such as the person who made the decision or the company whose product was
  configured. A passing mention is not a subject. Two or three subjects is
  usually enough.
- A preference or decision stated by a person belongs on that person's page.
  Do not turn one person's preference into a project or company policy.
- Match identity on evidence, not on similar names. When a claim names something
  that might be an existing page (for example a product name that could be a
  different service), confirm it from evidence such as configuration, a URL or
  the page's own aliases. If it stays uncertain, leave the claim unlinked and
  report it.

Link with `knowledge_annotate` `entities`, passing the complete list (it replaces
the existing one) and the claim's current revision and hash. Assertion text,
evidence and lifecycle stay unchanged.

## 3. Create missing pages

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
a dated Timeline. Then link the claims to the new page, keeping their existing
subjects as secondaries, and link the new page from its parent page.

## 4. Retire duplicates and replaced claims

- **Duplicate:** two claims assert the same fact, decision or preference about
  the same event. Keep the one with owner-approved recall, otherwise the earlier
  one, otherwise the one with fuller attribution. Copy any evidence the survivor
  lacks with `knowledge_annotate` `addEvidence`, then `knowledge_withdraw` the
  other with a reason that names the survivor's ID.
- **Replaced:** a later claim explicitly corrects the earlier one (for example an
  assistant correcting its own report), decides a question the earlier claim left
  open, or reports the final state of the same specific item (same PR, commit or
  decision). Withdraw the earlier claim with a reason that names the replacing
  claim. Do not use `knowledge_correct` here: it publishes a new copy of the
  replacement, which creates another duplicate.
- **Neither:** snapshots of different moments (CI red at one head, a merge later)
  are history, not errors. Keep them. Contradiction alone does not justify a
  withdrawal. When unsure, keep both and report the pair.

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
`expectedLinks` for each new or edited page. Enumerate the residue again: new
remembered claims may have arrived while you worked. Handle them the same way
or report them.

Report the number of claims examined and linked, pages created, claims withdrawn
(with the surviving or replacing claim for each), pages edited, and claims left
unlinked with the reason for each. When running unattended, never ask for a
decision: leave uncertain identities, uncertain duplicates and pages you would
only create on a guess untouched, and list them in the report for a person.

## Scribe setup

The **Review unlinked claims** scribe runs this review unattended. Its
messages follow [scribe setup](references/scribe-setup.md) with id
`unlinked-review`; it is always ongoing.

- **Setup:** declare the automation with schedule `45 3 * * 0` (Sundays 03:45
  in the received timezone). Maintenance queues this job, found by its
  declaration key, after each nightly pass that leaves private claims unlinked
  (unless `maintenance.reviewJobId` names another job); the weekly schedule only
  catches what maintenance missed, without a daily turn that finds nothing.
- **Scheduled run:** work through steps 1 to 6, and check the residue again
  before stopping, since claims saved during the run are part of the same
  backlog. With nothing to do, say so in one sentence. Otherwise give the
  step 6 report. `summary` counts claims examined, linked, withdrawn and left.

The owner sets the scribe up by sending the setup message from a new
conversation in their direct chat. Disable the automation to pause the review. Resetting or removing the scribe's conversation revokes its access;
start the scribe again.
