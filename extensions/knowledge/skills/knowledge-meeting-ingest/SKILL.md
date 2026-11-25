---
name: knowledge-meeting-ingest
description: Ingest meeting transcripts from any recorder into Knowledge with attendee enrichment, source notes, supported decisions and commitments, and verification of substance and sequence. Summary-only input is not a verified meeting ingestion.
---

# Meeting ingestion

Turn one transcript into a sourced meeting page, updated entity profiles, and
structured claims, then verify them. Read a reference only when its step needs it,
and don't reread one after compaction unless you are about to use it again:

- [setup](references/setup.md): always, first (status, ontology, search)
- [source acquisition](references/source-acquisition.md): fetching from an API, including Granola
  through its plugin
- [sources](references/sources.md): retaining originals; citation format
- [speakers](references/speakers.md): possible split, duplicate or unclear speaker
- [identity](references/identity.md): resolving a person, company or project
- [writing](references/writing.md): before writing any page prose
- [meeting page](references/meeting-page.md): writing the meeting page
- [subject pages](references/profiles.md), plus only the layout for the
  entity's type: creating or updating a profile or entity page
- [source notes](references/source-notes.md): the `attended` and `discusses` edges
- [assertions](references/assertions.md): claims, attendance edges, reruns
- [publish](references/publish.md): batch or page writes
- [recovery](references/recovery.md): any uncertain, rejected or conflicting write
- [verify](references/verify.md): verification and report

## Contract

- One page per real meeting. Retain the full transcript; recorder summaries are
  claims, not facts.
- Speakers are resolved on evidence with a confidence, never guessed. Use every
  real signal; leave a speaker unresolved only when there is none.
- Every participant (spoke, was addressed, or otherwise took part) gets a
  profile and an `attended` edge whose body is their source note.
  Invite-list-only names get neither.
- Every company, project or concept the meeting says something substantive
  about gets a page (found or created), a link from the meeting, and a
  `discusses` edge (meeting → entity) whose body is its source note. Passing
  mentions don't. Entity pages get no Timeline line; their Timeline is derived.
- Entity pages stay current explanations: each fact goes to the most specific
  existing page, State is rewritten in place, and a page gets no section or
  topic per meeting. A page that is already current gets only the new facts and
  its source note. Every existing citation stays.
- Pages read like good human notes: names first, few caveats, no process
  commentary.
- Decisions, commitments and events become claims. Unverified claims don't
  spread to other pages.
- Never call a meeting fully ingested until verification passes.

## Steps

### 1. Acquire and normalize

Get the complete transcript. Empty, summary-only or in-progress input fails this
step: report it. If the user only wants notes saved, use `knowledge-capture` and
say the meeting ingestion is not complete.

Normalize in working context to: source, source_id, title, date, time, duration,
attendees (source claims), ordered segments with `speaker`, `speaker_raw` and
`text`, source summary, URL. Unknown values are null. Recorder-specific handling
ends here; every recorder runs the same steps after this.

Retain the original export and the transcript ([sources](references/sources.md)).
Normalized text is a labeled derivative. Report acquisition, retention and
publication separately, with real counts ("9/16 originals retained").

Read the normalized transcript once, in sections of about 150 lines. After each
section, append to a working digest file: the line range, who spoke, topics,
candidate decisions, commitments and facts with exact line citations, quote
candidates, and new proper nouns. Later steps draft from the digest. Return to the
transcript only for specific line ranges (to check wording or a quote), never for
a full reread.

**Done when:** complete transcript retained; evidence receipts in hand; digest
covers every line.

### 2. Split, dedup, resolve speakers

Check for a multi-meeting recording, an existing page for this meeting, and the
speaker map ([speakers](references/speakers.md)).

**Done when:** each real meeting has its segment range; duplicates found; every
speaker label is mapped or explicitly unresolved, with basis.

### 3. Gate each claim

Check every proposed assertion against the transcript and earlier Knowledge about
the same entity.

- Role or relationship: explicit passage, not implication.
- Ownership: explicit ownership language; mentioning a name is not owning it.
- New proper noun: search Knowledge, then the web if allowed, for the canonical
  spelling; otherwise write it as `Name (unverified spelling)` and give it no
  page or link.
- Major life or deal event: verbatim support, checked against existing chronology.

Transcript support is not enough on its own. Also check:

- **Contradiction:** does it conflict with what Knowledge already establishes?
  Established content wins by default. Don't write the conflicting claim into
  profiles; keep it on the meeting page with both citations and list it in the
  report for the user to resolve. Override only with explicit, verbatim support,
  and still report the change.
- **Plausibility:** is it possible given what else is known? (Two people can't
  both have started the same project; a company founded last year wasn't
  acquired five years ago.) An impossibility usually means a garble.
- **Surprise:** if the user would say "wait, what?", apply every check. Surface
  the surprise as a question; don't explain it away.

Inferences and uncertain identities stay labeled on the meeting page and never
enter profiles, timelines, metadata or relationships as fact.

**Done when:** each claim is marked publish, label-as-uncertain or withhold.

### 4. Publish

Order: meeting page → entity pages → claims and edges → link edits.
Batch related records ([publish](references/publish.md)).

- Meeting page per [meeting page](references/meeting-page.md).
- For each participant and substantive entity, follow the steps in
  `knowledge-entities`' SKILL.md: it resolves the entity, decides whether it gets
  a page, and writes the profile and source note. Its references with the same
  names as this skill's are identical copies; use the ones you already read and
  don't reread them. Its only extra reference is enrichment (read its
  "During ingestion" section).
- Claims per [assertions](references/assertions.md): decisions, commitments,
  facts and one `source_event: true` event for the meeting itself, with all
  relevant `entities`. Other events keep their own dates.
- An evidenced `attended` relationship per participant. In the shipped ontology it
  runs participant → meeting; confirm in the definition. Set `source_page`. Its
  body is one sentence on what this person did or said in the meeting.
- An evidenced `discusses` relationship (meeting → entity) for each substantive
  non-participant, including mentioned people with pages, with the same kind of
  one-sentence body. Don't create pages for unknown speakers.
- For legal or personal content, keep the meeting page factual and limit spread
  to profiles; ask if scope is unclear.

**Done when:** every planned record has a published receipt in your work log.

### 5. Verify (hard gate, every meeting)

Run [verify](references/verify.md) first. Then check:

- **Substance:** required sections have content or a source-grounded reason.
- **Links:** `knowledge_verify` `expectedLinks` for meeting → each entity, plus
  claim `entities`/`dependencies`, commitment `owner`, and edge
  `from`/`to`/`label`/`source_page`. Every linked entity has an `attended` or
  `discusses` edge with a body for this meeting.
- **State:** no updated page gained a topic or section named for a date or
  meeting, and each follows its type's layout. Older dated sections beyond the
  retirement allowance ([retire dated sections](references/retire-dated.md))
  are listed in the report, not a failure.
- **Style:** check the drafts in your work files against
  [writing](references/writing.md) before publishing: names first, no stacked
  caveats, no notes to yourself, no filler lines. Don't read published pages back
  to check style; after a fix, reread only the section you changed.
- **Speakers:** no raw label passes as a known person; run the
  fabricated-attendee check in [speakers](references/speakers.md).
- **Quotes:** read each quoted span's lines with `knowledge_evidence_read`. Only
  filler ("like", "you know") may differ. Fix a failing quote by restoring the
  spoken words or choosing a cleaner span; never keep a paraphrase in a quote.
- **Sequence:** compare narrated order (before/during/after, places, people) with
  timestamps, independently of heading order. Use
  `knowledge_chronicle_day` (meeting date and timezone) and `knowledge_timeline`
  for related entities. An inversion or impossible place/time is a contradiction;
  never invent transit. Fix and recheck, or record an explicit user waiver as
  WAIVED, not resolved. A waiver covers sequence only. A participant missing from
  the day's chronicle usually means the meeting's `source_event` claim lacks
  them in `entities` (an attendance edge alone does not date anyone):
  investigate, don't block. Genuinely ambiguous order is flagged in the report, not blocked.

**Done when:** all checks pass, or failures are fixed and rechecked.

## Report

One line per meeting (one per page for a split recording): page, retained
sources, participants enriched, entities updated or reused, action items, claims
and edges, verification result, sequence PASS or WAIVED with the open
contradiction. List contradictions with existing Knowledge, withheld claims,
unresolved identities and remaining work here, in the report, not on the pages;
the user resolves them. If a check can't pass, report the meeting as not
ingested and name the check. A partial report is honest progress, not
completion.

## Scribe runs

The **Learn from Granola** scribe runs this skill unattended. Its prompt checks
access, sets up any automation and lists its settings. Do not ask questions.

### Learn from Granola

Task: ingest the Granola meetings in the settings. Follow
[Learn from Granola](references/scribe-runs.md#learn-from-granola).
