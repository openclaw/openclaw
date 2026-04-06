---
name: pickle-contacts
description: Create pickleball invite lists from a Google Contacts export/merged CSV by filtering tagged contacts (e.g., CKS), extracting ladder ratings (LR: or embedded numeric ratings), applying rating ranges, and outputting a CSV including First Name, Last Name, Rating, Phone, and Email.
---

# Pickleball Contacts

Use this skill to reliably generate an **invite list CSV** from a contacts export/merged CSV when Davo asks things like:

- “Create a file of my Google Contacts with `pkb` and `CKS` in their name, with ratings between X and Y.”
- “Generate today’s Creekside invite list.”

This skill is intentionally **contacts-only**. Bulk/drip SMS is handled separately by the `texts-with-approval` skill.

## Inputs (source of truth)

Typically a CSV exported/maintained from Google Contacts and then augmented with tags/ratings, e.g.:

- `~/.openclaw/workspace/temp/pkb_contacts_merged_YYYY-MM-DD-vN.csv`

Expected columns (current workflow):

- `First Name`
- `Old Last Name`
- `Last Name`
- `Phone`
- `Email`

If the user asks to export from Google Contacts first, use the `google-contacts` skill to generate a comprehensive export, then run this process on the exported file.

## Workflow (invite list)

1. **Filter invite candidates**

- Include only rows whose `Last Name` contains `CKS` (case-sensitive).
- Important: filter on `Last Name` (not `Old Last Name`).

2. **Extract rating (numeric)**

- Prefer `LR:<number>` anywhere in the row.
- Else find the first token matching `([345]\.\d+)` anywhere in the row.
- If no rating is found, record as a failure.

3. **Apply rating range**

- Default range: **3.4 to 4.7** (inclusive), unless the user specifies otherwise.

4. **Normalize First Name**

- Output first name = first word of the `First Name` field, capitalized.

5. **Include contact fields**

- Copy `Phone` and `Email` into output.

6. **Optional discard list**

- If user provides a list of already-signed-up people, discard them using light fuzzy matching.

## Outputs

- Invite list CSV: `First Name, Last Name, Rating, Phone, Email`
- Failures CSV: rows where rating extraction failed

## Script

Use:

- `scripts/extract_invite_list.py`

Example:

```bash
python3 skills/pickle-contacts/scripts/extract_invite_list.py \
  --in ~/.openclaw/workspace/temp/pkb_contacts_merged_2026-03-26-v4.csv \
  --out ~/.openclaw/workspace/temp/pkb_invite_list_2026-03-26_with_contact.csv \
  --failures ~/.openclaw/workspace/temp/pkb_invite_list_2026-03-26_with_contact_failures.csv \
  --min 3.4 --max 4.7 \
  --tag CKS \
  --discard "Alyson Wells, Vickie Freshour, Vlad G, Weston McKinney, Chase Highley, Steven Jackson, M Gerst"
```

## References

- `references/invite-list-process.md`
