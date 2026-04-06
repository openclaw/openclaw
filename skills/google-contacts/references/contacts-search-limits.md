# Google Contacts search limits and reliable workaround

## Problem

`gog contacts search <query>` can return an incomplete subset of matches for broad queries like `pkb`.

In the observed failure mode:

- `gog contacts search pkb` returned only 30 results
- the account actually had many more matches
- agents can falsely conclude the result set is complete if they trust `search`

## Reliable approach

Do not rely on `gog contacts search` when the user expects comprehensive results.

Instead:

1. page through `gog contacts list --json --no-input --max 1000`
2. follow `nextPageToken` until exhausted
3. filter locally against `name`, `email`, and/or `phone`
4. dedupe by `resource`
5. write JSON/CSV if the user wants an artifact

## Why this works

`gog contacts list` exposes pagination and can enumerate the full reachable contact corpus for the account. Local filtering avoids the result cap behavior of `search`.

## Recommended script

Use `scripts/fetch_contacts.py` in this skill.

Example:

```bash
python3 /absolute/path/to/google-contacts/scripts/fetch_contacts.py \
  --account admin@focus.ceo \
  --query pkb \
  --json-out /tmp/pkb_contacts.json \
  --csv-out /tmp/pkb_contacts.csv
```

## Output behavior

The script prints a JSON summary to stdout with:

- query
- fields searched
- pages fetched
- total contacts scanned
- match count

If requested, it also writes:

- JSON array of matching contacts
- CSV with `resource,name,email,phone`

## Agent guidance

- Prefer `gog contacts search` only for small spot checks where completeness is not critical.
- Prefer paginated list + local filter whenever the user asks for all matches, suspects missing contacts, or wants a report/export.
- Always mention that the workaround is deliberate, so future agents do not regress to `search` and hit the same cap again.
