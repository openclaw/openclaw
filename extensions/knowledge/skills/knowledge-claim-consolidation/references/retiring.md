# Retire duplicates, replaced claims and snapshot series

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
  - the outcome and the snapshots share a subject page (link them first,
    [linking](linking.md)); the tool rejects claims with no common page.
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

## Keep citations current

A page that cites a claim you withdraw or supersede would cite an inactive
record. Before the write, list the pages that cite the claim with
`knowledge_connections` `direction: "backlinks"`. After it, read each citing
sentence (from a fresh full read) and fix it with `knowledge_edit_body`:

- The survivor states the same fact (a duplicate): repoint the link to it.
- The replacement says something different (an outcome superseding snapshots,
  a correction): on an entity page, rewrite the sentence to what is true now
  and cite the replacement. On an authored document, keep the sentence and its
  citation and add a dated amendment citing the replacement.

Check the edited pages with `knowledge_verify` `expectedLinks`.
