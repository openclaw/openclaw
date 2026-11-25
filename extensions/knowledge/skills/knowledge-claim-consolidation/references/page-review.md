# Review a page

A page review makes one entity page (person, company, project, concept) read as
a current explanation of its subject. The correct result for most pages is no
change. Read [subject pages](profiles.md) for the rules and only the layout for
this page's type. Do not review authored documents (designs, plans, writing),
meeting pages or source pages this way.

Work from claim rows. Read a claim in full only when you are about to change
it, and never read whole source transcripts: the rows and the citations already
on the page carry what a review needs. If you hand claim groups to helper
sessions, wait for their results and give the report yourself.

## 1. Read

Read the whole body: follow the top-level `nextOffset` with `offset` until it
is absent, and compare the hash across chunks. Keep the revision and hash. List
the page's claims ([linking](linking.md), One page). On a page with hundreds of
claims, read the newest first (`knowledge_timeline` with `entity` and
`timeField: "recorded_at"`, or the rows' days), then older ones by group.

## 2. Judge

Check each part and note which fail:

- **Introduction:** does it say what the subject is, not what source mentioned
  it?
- **State:** is each topic current? Is any decision, outcome or commitment
  among the newer claims missing, or does a newer claim contradict the text?
- **Dated material:** is there a written Timeline, a section named for a date or
  source, or a paragraph that summarizes one meeting?
- **Layout:** do the sections fit the page's type? It fails when another
  type's headings appear (project headings on a concept page); when decisions,
  outcomes, dated milestones or open commitments sit in State instead of the
  type's sections; or when the type's leading section is missing although the
  claims support it (company Relationship, project Key decisions). A section no
  claims support is optional, and its absence does not fail.
- **Prose:** it fails on a hedge repeated across sentences ("is not proof",
  "does not establish") or a sentence carrying more than about three
  citations.
- **Citations:** does every `[[id|label]]` resolve to a current record?
  `knowledge_connections` `direction: "links"` on the page lists the current
  records it links to; a body link missing from that list is broken or points
  at a retired record.

If every part passes, change nothing and report "no change". This is the
expected result for a current page, not a missed opportunity.

## 3. Fix only what fails

- **Stale or missing fact:** rewrite that State topic or type section so it
  leads with what is true now, citing the claims with `[[claim-id|label]]`.
  Check mutable status live before writing it as current (for example `gh pr
  view` for merge state) and say when you checked. A merge is not a deployment,
  and a deployment is not proof that a given Gateway runs the code. A series of
  progress snapshots collapses into its outcome; snapshots are at most dated
  claims, never State.
- **Introduction:** rewrite it from the current claims and the facts the body
  already cites.
- **Dated material:** retire every dated section and the written Timeline
  ([retire dated sections](retire-dated.md)). This is part of every review that
  finds one, not optional cleanup. Synthesize: several dated reports about one
  subject become one current sentence in its topic, not a rearranged list.
- **Layout:** move the misplaced items from State into the type's sections,
  adding the leading section the claims support
  ([sections by type](profiles.md#sections-by-type)). This moves items; it is not
  a rewrite of the page.
- **Prose:** state a qualifier once, where it matters. Merge duplicate
  citations and move the rest beside the specific facts they support.
- **Broken citation:** repoint it to the record that now holds the same fact
  (a duplicate's survivor, or the page an extraction moved it to). When the
  replacement says something different (an outcome superseding a snapshot),
  rewrite the sentence to what is true now and cite the replacement.

Leave every passing part as it is. Do not reword, reorder or reorganize text
that passes. Restructuring the whole page or splitting it needs a reason from
[the default of no change](profiles.md#the-default-is-no-change), named in the
report. A section about a clearly separate subject moves to that subject's page
with `knowledge_extract_section` (creating the page as in [linking](linking.md)
when needed); extraction makes the destination the first subject of the claims
the section cites, so recheck each of those claims' `entities` afterwards.

## 4. Rewrite without losing anything

- Rewrite, merge or remove body text only when every fact it carried is held by
  a current claim, a source note or a retained source the page still reaches. A
  fact that lives only in the prose becomes a claim first.
- Keep every citation beside its fact
  ([keep citations reachable](profiles.md#keep-citations-reachable)). Before
  deleting text, check each `[[id|label]]` link in it.
- Keep user-written assessments, verbatim quotes, recorded disagreement and
  stated uncertainty.
- Remove what explains nothing: status a later outcome replaced, a hedge
  repeated on every sentence ([writing](writing.md)).

## 5. Publish

Publish with `knowledge_edit_body`, one section at a time, as you finish each,
so a long review keeps its work. Compute UTF-16 offsets from a fresh full read
and reread the revision and hash before every edit. Replacing a whole section is
expected here, and an edit that shrinks the body always succeeds. A growing edit
rejected for its size budget: [page budgets](publish.md#page-budgets).

## 6. Reread

Reread the published page as a teammate who has never seen it: what is this,
where does it stand, what is open? Fix what still fails, or report it. Run
`knowledge_verify` with `expectedLinks` for every citation you kept or added.

Report one line for the page: no change; fixed (which parts); or restructured
or split (the reason), plus any lines you could not account for.

## Scribe page choice

The scribe keeps the note page `Knowledge scribe checkpoint · Knowledge
Consolidation` (create it with `knowledge_save_page`, type `note`, on the
first run): one line per reviewed page with its ID, title, date and result.
Skip pages it lists from the last 30 days. Choose entity pages in this order:

1. Pages with sections named for a date or source: `knowledge_grep` with
   `kind: "page"` and `mode: "phrase"` for `Context ·` and `Source context`,
   confirming the heading in the body. Largest first.
2. Pages whose claims have outrun the body: among the recently active pages in
   the Knowledge index, the ones with the most new claims.
3. One page the checkpoint has never listed, whatever its size, so ordinary
   pages are sampled too.

Update the checkpoint after each page, so an interrupted run resumes.
