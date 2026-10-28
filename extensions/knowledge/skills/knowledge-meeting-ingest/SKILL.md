---
name: knowledge-meeting-ingest
description: Ingest meeting transcripts from any recorder into Knowledge with attendee enrichment, timeline merge, supported decisions and commitments, and verification of substance and sequence. Summary-only input is not a verified meeting ingestion.
---

# Meeting ingestion

Turn one transcript into a sourced meeting page, updated entity profiles, and
structured claims, then verify them. Read a reference only when its step needs it:

- [setup](references/setup.md): always, first (status, ontology, search)
- [source acquisition](references/source-acquisition.md): fetching from an API, including Granola
  through its plugin
- [sources](references/sources.md): retaining originals; citation format
- [speakers](references/speakers.md): possible split, duplicate or unclear speaker
- [identity](references/identity.md): resolving a person, company or project
- [writing](references/writing.md): before writing any page prose
- [meeting page](references/meeting-page.md): writing the meeting page
- [profiles](references/profiles.md): creating or updating a profile
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
  profile with a Timeline line and an attendance edge. Invite-list-only names
  get neither.
- Every company, project or concept the meeting says something substantive
  about gets a page (found or created), a Timeline line and links in both
  directions. Passing mentions don't.
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
  a page, and writes the profile and Timeline line. Its references with the same
  names as this skill's are identical copies; use the ones you already read and
  don't reread them. Its only extra reference is enrichment (read its
  "During ingestion" section).
- Claims per [assertions](references/assertions.md): decisions, commitments,
  facts and one `source_event: true` event for the meeting itself, with all
  relevant `entities`. Other events keep their own dates.
- An evidenced `attended` relationship per participant. In the shipped ontology it
  runs participant → meeting; confirm in the definition. Set `source_page`.
- Mentioned people with pages get links too. Don't create pages for unknown
  speakers.
- For legal or personal content, keep the meeting page factual and limit spread
  to profiles; ask if scope is unclear.

**Done when:** every planned record has a published receipt in your work log.

### 5. Verify (hard gate, every meeting)

Run [verify](references/verify.md) first. Then check:

- **Substance:** required sections have content or a source-grounded reason.
- **Links:** `knowledge_verify` `expectedLinks` for meeting ↔ each entity, plus
  claim `entities`/`dependencies`, commitment `owner`, and edge
  `from`/`to`/`label`/`source_page`. Every linked profile has a Timeline line
  for this meeting.
- **State:** no updated profile has a State topic named for a date or meeting.
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
  the day's chronicle usually means a missing Timeline line: investigate, don't
  block. Genuinely ambiguous order is flagged in the report, not blocked.

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
access, sets up any automation and lists its settings; this section is only the
work. Do not ask questions. Acquire with the Granola plugin's tools
([source acquisition](references/source-acquisition.md)).

### Learn from Granola

The prompt names which meetings (the owner's, or every meeting the account can
read) and how far back to start (today, or the last 7 or 30 days, in the owner's
time zone).

1. **Plugin.** Tool search for `granola list_meetings`. If the Granola tools
   are missing or say the account is not connected, stop with
   `Scribe status: failed — the Granola plugin is not installed or connected`.
2. **Checkpoint.** `knowledge_lookup` the note page
   `Knowledge scribe checkpoint · Learn from Granola`. Its body lists one line
   per Granola meeting handled: meeting date, UUID, `updated_at`, and the outcome (meeting
   page title, `already in Knowledge`, or `no transcript`). Create it with
   `knowledge_save_page` (type `note`) on the first run.
3. **List.** `list_meetings` from the prompt's start date on the first run,
   otherwise from 7 days before the newest meeting date in the checkpoint,
   through today.
   For the owner's meetings pass
   `involvement: {captured_by_me: true, listed_as_participant: true}`. Follow
   `next_cursor`. Skip meetings already in the checkpoint, unless a later
   `updated_at` shows a note that was still being written last time.
4. **Dedup.** Before acquiring, `knowledge_grep` the UUID, then the meeting
   title, and read candidate meeting pages with the same date (±1 day). A
   match is recorded as `already in Knowledge` and skipped.
5. **Ingest.** Oldest first, one meeting at a time, run steps 1–5 of this skill
   in full. Leave a meeting still being recorded or with a pending transcript
   for the next run; record `no transcript` for one that has none. After each
   meeting passes verification, add its checkpoint line with
   `knowledge_edit_body`, so an interrupted run resumes instead of redoing it.
   A meeting that fails verification gets no line; say so in the counts. If
   context runs short, stop after the current meeting and leave the rest.
6. Count meetings ingested, already in Knowledge, skipped and left for later,
   and pages and claims written.
