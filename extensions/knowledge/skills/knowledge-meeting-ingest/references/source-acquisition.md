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

## Granola REST reference

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
