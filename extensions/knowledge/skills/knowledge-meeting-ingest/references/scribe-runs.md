# Scribe runs

The scribe's prompt checks access, sets up any automation and lists its
settings; this is only the work. Do not ask questions. Acquire with the Granola
plugin's tools ([source acquisition](source-acquisition.md)).

## Learn from Granola

The pending, checkpoint and completion rules below address the November 12, 2026
live run that stopped after digesting a meeting instead of finishing ingestion:
[#197890](https://github.com/openclaw/openclaw/pull/197890) and
[#197391](https://github.com/openclaw/openclaw/pull/197391).

The prompt names which meetings (the owner's, or every meeting the account can
read) and how far back to start (today, or the last 7 or 30 days, in the owner's
time zone).

1. **Plugin.** Tool search for `granola list_meetings`. If the Granola tools
   are missing or say the account is not connected, stop with
   `Scribe status: failed — the Granola plugin is not installed or connected`.
2. **Checkpoint.** `knowledge_lookup` the note page
   `Knowledge scribe checkpoint · Learn from Granola`. Its first line is
   `Start: YYYY-MM-DD`, the start date the prompt set when the page was
   created. Then one line per Granola meeting: meeting date, UUID,
   `updated_at` and a state: `done` (with the meeting page title), `no
   transcript`, or `pending` (with why). Lines record outcomes only: never
   write resume notes, plans or instructions for a later run on the page.
   Create the page with `knowledge_save_page` (type `note`) on the first run,
   writing the prompt's start date.
3. **List.** `list_meetings` from the later of `Start` and 7 days before the
   newest `done` meeting date, through today; never earlier than `Start`. For
   the owner's meetings pass
   `involvement: {captured_by_me: true, listed_as_participant: true}`. Follow
   `next_cursor`. Add every `pending` meeting by UUID (read with
   `get_meetings`), whatever its date, so it is retried until it is `done` or
   `no transcript`. Skip `done` and `no transcript` meetings unless a later
   `updated_at` shows the note changed.
4. **Dedup.** Before acquiring, `knowledge_grep` the UUID, then the meeting
   title, and read candidate meeting pages with the same date (±1 day). A
   page is not proof of a complete ingestion: an earlier run may have stopped
   after publishing it. Run the verification in step 5 against the existing
   page. If it passes, record the meeting `done` and skip it. Otherwise
   reconcile into that page ([speakers](speakers.md)) and finish
   steps 3–5 for it; never create a second page.
5. **Ingest.** Oldest first, one meeting at a time, run steps 1–5 of this skill
   in full. A meeting you start, you finish: acquiring or digesting a meeting
   is not a stopping point. `pending` is only for reasons outside the run: the
   meeting is still being recorded, its transcript is not ready yet, or
   verification still fails after you tried to fix it. Record `no transcript`
   for one that has none. Record `done` only after verification passes. Write
   each line with `knowledge_edit_body` as soon as the meeting's outcome is
   known, so an interrupted run resumes instead of redoing or losing it.
6. Count meetings ingested, already in Knowledge, left pending and without a
   transcript, and pages and claims written. If meetings are left pending, none
   was ingested and nothing outside the run held them back, the run did not do
   its work: end with `Scribe status: needs attention — <why>` instead of
   `on`.
