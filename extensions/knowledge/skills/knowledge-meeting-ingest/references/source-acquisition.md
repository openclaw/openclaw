# Source acquisition

Use an available connector/export before adding infrastructure. Acquire only the
requested source. Keep source IDs, acquisition time, returned update timestamp,
page/segment counts, coverage bounds and original-byte hashes in the task work
log. Retain raw responses separately from normalized text. A hash identifies
bytes; it does not establish completeness.

For any paginated source, preserve filters while following the returned cursor.
Validate the response shape; do not treat a missing continuation field as an
empty final page. A missing/repeated cursor while more pages are advertised is
an incomplete fetch, not success. Retry the same failed page without appending
it twice. Preserve segment order; identical spoken text can legitimately recur.
If the source changes during acquisition, reconcile/refetch rather than silently
combining versions. Finish acquisition before publication; a saved summary or
the first page of a transcript is not a complete original.

## Granola through the Granola plugin (MCP)

Prefer this when the Granola plugin is installed and connected: its tools are
`list_meetings`, `get_meetings` and `get_meeting_transcript` (find them with
tool search for "granola"). The plugin holds the sign-in; never ask for or store
an API key. If the tools are missing or report that the account is not
connected, stop and say the Granola plugin needs to be installed or connected
from the Plugins page.

- **IDs.** Tools return the meeting UUID, the same one as in
  `https://notes.granola.ai/d/<uuid>`. They also accept the REST API's `not_…`
  note ID. Record the UUID and the notes URL on the meeting page as the source
  ID. Earlier ingestions may cite only a `not_…` ID, so dedup by UUID or URL
  first, then by title, attendees and date ([speakers](speakers.md)).
- **List.** `list_meetings` with `time_range: "custom"`, `from_date`,
  `to_date` (`YYYY-MM-DD`, user's time zone) filters by the scheduled meeting
  start, newest first. Follow `next_cursor` with the same filters while
  `has_more` is true. `updated_after` picks up changed notes. Without an
  `involvement` filter it includes notes other people captured and shared;
  `involvement: {captured_by_me: true, listed_as_participant: true}` keeps the
  owner's meetings. `known_participants` is the invite list, not attendance.
- **Metadata.** `get_meetings` (up to 10 IDs, `attachments: "none"`) returns
  title, `meeting_at`, `created_at`, `updated_at`, participants, the AI
  summary and the owner's private notes. The summary is a source claim.
- **Transcript.** `get_meeting_transcript` with `include_timestamps: true` and
  `max_chars` up to 80000 returns text blocks like
  `[12:04] System audio: …`. Continue from `next_offset` with the same
  `include_timestamps` until `truncated` is false, and concatenate the pages'
  `transcript` strings in order; a block cut at a page end
  (`ends_mid_utterance`) continues on the next page. Timestamps count from the first block, not the
  clock. `Microphone` is the recorder's track and `System audio` everyone on
  the call ([speakers](speakers.md)). `transcript_unavailable` with
  `transcript_pending` means try a later run; `no_transcript` and
  `transcript_deleted` are final, and such a meeting cannot be ingested.
- **Still recording.** Skip a meeting whose `updated_at` is under 20 minutes
  old or whose transcript is pending.
- **Originals.** Retain the `get_meetings` result text and the joined
  transcript text as two originals. With Code Mode, pipe each tool result
  straight into `knowledge_attach` without printing it. Otherwise write the text
  exactly as returned to a file in the workspace with the host file tool, check
  that the transcript file's character count matches `total_chars` (more than
  a few characters off means the copy is incomplete: write it again), and
  retain it with `knowledge_attach_file`. Never retain a summary in place of the
  transcript.

## Granola REST reference

Use the public REST API only when the Granola plugin is not available and the
owner has set up an API key.

Checked against the official API docs on 2026-09-24. Recheck if the API rejects
these parameters; do not substitute parameter names from another connector.

- Base: `https://public-api.granola.ai/v1`.
- List: `GET /notes` with `created_after`, `created_before`, `updated_after`,
  `page_size` (1–30), and opaque `cursor`. Do not use `start_date`, camelCase
  filters or `limit`. Creation filters select note creation, not necessarily
  meeting occurrence; verify the returned calendar/transcript date. Translate
  requested local dates with the applicable timezone, including DST.
- Detail: `GET /notes/{note_id}?include=transcript`; use the returned `not_...`
  ID, not the UUID embedded in the sharing URL.
- If inline retrieval returns HTTP 413 / `TRANSCRIPT_TOO_LARGE`, fetch note
  metadata without `include`, then `GET /notes/{note_id}/transcript` with
  `page_size` (1–100) and `cursor`. Append each `transcript` array until
  `hasMore` is false. The final short page is not an error. Note-list and
  transcript pagination are independent.

Sources: [List Notes](https://docs.granola.ai/api-reference/list-notes),
[Get Transcript](https://docs.granola.ai/api-reference/get-transcript),
[API overview](https://docs.granola.ai/introduction).

Use the host's existing authorized credential mechanism; never put key values
in source artifacts, tool arguments or logs. A saved secret reference only
identifies a credential—it does not grant access or eliminate authorization
prompts. Pagination/validation failures are not reasons to reacquire a key.
Honor rate-limit backoff and bound retries; report persistent failures and
retained partial coverage rather than declaring a complete import.
