# Enumerate, link and create pages

## Enumerate the scope

Enumerate exactly one starting set:

- **Unlinked residue.** Run `knowledge_relink` without `dryRun` first so every
  remembered claim it can link is linked. Then list the residue with
  `knowledge_relink` `dryRun: true`, `include: "all"` and `limit: 10`,
  following `nextCursor`: every current claim with no linked page and no source
  page, whichever tool saved it. Each call reports at most 10 examples per
  outcome, so a limit of 10 returns every claim it examined.
- **One page.** List its current claims with
  `knowledge_connections` `id` and `direction: "claims"`; each row carries the
  claim's text, kind, day, linked page titles and 16-character hash. Follow
  `nextOffset` with the same filters. Restart when `snapshot` changes, at most
  twice: your own and other sessions' writes change it, so after that continue
  with the latest complete listing and catch new claims when you enumerate
  again at the end. On a hub, group from the rows and work one group at a time;
  do not read every claim in full up front.
- **One subject, optionally since a date.** When the subject has a page, list
  its claims with `knowledge_timeline` `entity`, `timeField: "recorded_at"`
  and `since`, following `nextOffset`. Also search for claims filed elsewhere
  or unlinked with `knowledge_grep` `kind: "claim"`, the subject's
  distinctive names (a PR number, a commit SHA, a feature name) and the same
  `since`/`timeField`. Keep only claims that are actually about the subject.

Read each claim you will change with `knowledge_record`. Its `subjectHint`,
when present, is the saver's own description of what the claim is about and the
strongest clue to its subject. Group the claims by what they are about (one
feature, PR, commit, decision thread, person or preference) before choosing
pages. Most claims make sense only next to their neighbours: a series of status
snapshots about one PR usually ends in an outcome claim.

## Choose subject pages

For each group, find candidate pages with `knowledge_grep` and
`knowledge_lookup`, and read their State. Ignore withdrawn pages and fixture
pages.

- The **primary subject** is what the claim asserts something about; list it
  first in `entities`. Add a secondary subject only when the claim also states
  something about that entity, such as the person who made the decision or the
  company whose product was configured. A passing mention is not a subject. Two
  or three subjects is usually enough.
- The primary subject is the **most specific** page the claim is about: a claim
  about one PR belongs on that PR's page, not only on the project the PR belongs
  to. The broader page stays a subject only when the claim says something about
  it, such as a project-level decision, policy or release.
- A preference or decision stated by a person belongs on that person's page.
  Do not turn one person's preference into a project or company policy.
- Match identity on evidence, not on similar names. When a claim names something
  that might be an existing page (for example a product name that could be a
  different service), confirm it from evidence such as configuration, a URL or
  the page's own aliases. If it stays uncertain, leave the claim where it is and
  report it.

Link with `knowledge_annotate` `entities`, passing the complete list (it
replaces the existing one) and the claim's current revision and hash. Assertion
text, evidence and lifecycle stay unchanged. Link a claim before you supersede
it: superseded claims cannot be relinked.

Before dropping a page from a claim's `entities`, check whether that page's
body cites the claim (`knowledge_connections` `direction: "links"` on the
page). A page that states the claim's fact is still a subject of it: keep it.

## Create missing pages and relink to them

Linking every claim to the nearest existing page can bury a real subject in a
broad page. Create a page only for a subject that is clearly separate (its own
name and identity, not a phase, component or facet that an existing page
explains) and big enough to stand alone:

- a discrete subject (a feature, project, tool or substantial PR) with roughly
  five or more claims, or its own design, proof and outcome history; or
- a person or organisation who authored, owns or decided something in the
  claims, has no page, and has identity evidence (for example the PR author
  shown by `gh pr view`).

Do not create a page for a single mention or a one-off fix that a dated claim
covers. Taking claims off a page to start a new one is a split: name the reason
in the report. Use `knowledge_save_page` with the ontology `type`, aliases,
and the identity evidence as `source`. Person pages use
`identity.status: partial` unless the identity is fully established. Write an
introduction and a short State that cites the claims, using the type's layout
([subject pages](profiles.md#sections-by-type)); its Timeline is derived. Link
the new page from its parent page.

Then relink the group's claims, including the snapshots you will supersede. The
new page becomes each claim's primary subject. Keep the broad page the claims
were filed on only for claims that say something about it, by the rules above;
drop it from the rest. Keep other existing secondary subjects that still
qualify. Under the threshold, leave the claims on their current pages.
