---
name: google-contacts
description: Work with Google Contacts via gog when agents need to search, export, or audit contacts and must return a complete result set. Use when a user wants all matching contacts, a filtered contact export, contact counts, CSV/JSON outputs, or when `gog contacts search` appears incomplete or capped.
---

# Google Contacts

Use this skill for reliable Google Contacts retrieval via `gog`, especially when completeness matters.

## Quick rule

If the user wants **all** contacts matching a query, do **not** trust `gog contacts search` as the final answer.

Read `references/contacts-search-limits.md` and use `scripts/fetch_contacts.py` to paginate `gog contacts list` and filter locally.

## Workflow

1. Confirm the account to query.
   - Prefer an explicit `--account`.
   - If the user already specified the account in prior context, keep using it.

2. Decide whether completeness matters.
   - If the user wants a spot check or a few likely matches, `gog contacts search` is acceptable.
   - If the user wants **all** matches, counts, exports, or is debugging missing contacts, use the paginated workflow.

3. Use the paginated workflow.
   - Run `scripts/fetch_contacts.py`.
   - Search `name,email,phone` unless the task clearly calls for narrower matching.
   - Write JSON/CSV outputs when the user asks for an artifact or when the result set is large.

4. Report clearly.
   - Say that the workflow paginated the full contact list and filtered locally.
   - Include total contacts scanned and total matches found.
   - If relevant, note that this avoids the capped behavior of `gog contacts search`.

## Commands

### Quick comprehensive search

```bash
python3 /absolute/path/to/google-contacts/scripts/fetch_contacts.py \
  --account admin@focus.ceo \
  --query pkb \
  --json-out /tmp/pkb_contacts.json \
  --csv-out /tmp/pkb_contacts.csv
```

### Narrower field matching

```bash
python3 /absolute/path/to/google-contacts/scripts/fetch_contacts.py \
  --account admin@focus.ceo \
  --query smith \
  --fields name,email
```

## Outputs

The script prints a JSON summary to stdout and can also write:

- JSON array of matching contacts
- CSV with `resource,name,email,phone`

## Important behavior notes

- `gog contacts list` supports pagination with `nextPageToken`; use that for exhaustive retrieval.
- Dedupe by `resource` so contacts seen across pages do not double-count.
- For scripting, always prefer `--json --no-input` behavior through the bundled script.
- If the user is comparing counts against the Google Contacts UI, mention that this skill intentionally avoids `gog contacts search` caps by enumerating the full list first.

## References

- Search/result-cap behavior and workaround: `references/contacts-search-limits.md`
