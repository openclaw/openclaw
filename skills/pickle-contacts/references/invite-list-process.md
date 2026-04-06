# Pickleball invite list extraction (CKS)

## Source of truth

A contacts CSV exported/maintained from Google Contacts and then augmented with tags/ratings. Example:

- `~/.openclaw/workspace/temp/pkb_contacts_merged_YYYY-MM-DD-vN.csv`

Expected columns (current workflow):

- `First Name`
- `Old Last Name`
- `Last Name`
- `Phone`
- `Email`

## Step-by-step

1. **Select invite candidates**

- Include only rows where `Last Name` contains the exact substring `CKS` (case-sensitive).
- Important: use `Last Name`, not `Old Last Name`.

2. **Extract rating**

- Prefer `LR:<number>` if present anywhere in the row text.
  - Example: `LR:4.15` -> `4.15`
- If no `LR:` exists, find the first rating-like token that matches:
  - starts with `3`, `4`, or `5`
  - contains a decimal point
  - regex: `([345]\.\d+)`
- If no rating can be found, flag the row as a failure.

3. **Range filter**

- Drop any rating < **3.4** or > **4.7** (inclusive range filter by default).

4. **Output fields**

- `First Name`: first word of the `First Name` field, capitalized.
- `Last Name`: keep as-is (this includes tags like `CKS`).
- `Rating`: parsed numeric rating.
- `Phone`, `Email`: copied from the same row.

5. **Optional: discard already-signed-up people**
   When Davo provides a short list of already-signed-up names, discard those candidates via lightweight fuzzy name matching.

## Script

Use `scripts/extract_invite_list.py`.

Example:

```bash
python3 /path/to/skills/pickle-contacts/scripts/extract_invite_list.py \
  --in ~/.openclaw/workspace/temp/pkb_contacts_merged_2026-03-26-v4.csv \
  --out ~/.openclaw/workspace/temp/pkb_invite_list_2026-03-26_with_contact.csv \
  --failures ~/.openclaw/workspace/temp/pkb_invite_list_2026-03-26_with_contact_failures.csv \
  --min 3.4 --max 4.7 \
  --tag CKS \
  --discard "Alyson Wells, Vickie Freshour, Vlad G, Weston McKinney, Chase Highley, Steven Jackson, M Gerst"
```
