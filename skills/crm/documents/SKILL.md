---
name: documents
description: Document management with markdown files, cross-nesting between documents and objects, and human-readable entry detail pages linked through the documents table.
metadata: { "openclaw": { "inject": true, "always": true, "emoji": "📄" } }
---

# CRM Documents

This skill covers document management, cross-nesting, and entry detail pages. For workspace fundamentals, see the parent **crm** skill (`crm/SKILL.md`). For creating objects, see **object-builder** (`crm/object-builder/SKILL.md`).

---

## Document Management

Documents are markdown files in `{{WORKSPACE_PATH}}/**`. The DuckDB `documents` table tracks metadata only; the `.md` file IS the content.

### Create Document

1. Write the `.md` file: `write {{WORKSPACE_PATH}}/projects/roadmap.md`
2. Insert metadata into DuckDB:

```sql
INSERT INTO documents (title, icon, file_path, parent_id, sort_order)
VALUES ('Roadmap', 'map', 'projects/roadmap.md', '<parent_doc_id>', 0);
```

### Cross-Nesting

- **Document under Object**: Set `parent_object_id` on the document. Place `.md` file inside the object's directory.
- **Object under Document**: Set `parent_document_id` on the object. Place object directory inside the document's directory.

---

## Notes Field vs Entry Documents

These are **not the same thing**:

- **`Notes` field**: a `richtext` value stored in DuckDB `entry_fields`
- **Entry document**: a standalone `.md` file on disk, linked to the entry through the `documents` table

When the user says:

- "fill in notes for each entry"
- "write descriptions for all rows"
- "add detailed writeups"
- "put the outreach draft into each influencer notes page"
- "create entry docs"

default to **entry documents** unless they explicitly say "update the Notes column/field".

If the user truly means the `Notes` field, they will usually talk about:

- a table column
- richtext field values
- filtering/sorting by Notes
- SQL updates to `entry_fields`

If they mean entry documents, they are talking about:

- markdown pages
- the entry detail panel
- prose content, drafts, meeting notes, SOPs, long-form notes
- files visible under the object in the sidebar

---

## Entry Detail Pages

Each entry in an object can have an optional markdown file that acts as its detail page in the entry panel.

**CRITICAL:** New entry documents should use **human-readable filenames**, not raw UUID filenames. The file must also be registered in DuckDB `documents` with `entry_id`, `parent_object_id`, and `file_path`.

### Required storage model

For every entry document:

1. Write a human-readable markdown file inside the object directory
2. Insert/update a row in `documents` linking the entry to that file

```sql
INSERT INTO documents (title, file_path, parent_object_id, entry_id)
VALUES (
  'Mike Murphy',
  'marketing/influencer/yt-mikemurphy-001.md',
  (SELECT id FROM objects WHERE name = 'influencer'),
  'yt-mikemurphy-001'
);
```

### Naming convention (MANDATORY)

Use this filename structure for entry documents:

`{human_readable_slug}-{sequence}.md`

Examples:

- `acme-corp-001.md`
- `jane-smith-001.md`
- `q2-renewal-deal-001.md`

If the entry clearly belongs to a source/domain where a prefix helps, include it:

- `yt-mikemurphy-001.md` for YouTube creators
- `x-somehandle-001.md` for X/Twitter creators

### How to choose the slug

Use the first strong human-readable identifier available:

1. `Document Slug`, `Slug`, or `File Slug` field if it exists
2. For YouTube creators: extract the handle from `YouTube URL` and prefix `yt-`
3. Otherwise use the primary text label, such as:
   - `Title`
   - `Channel Name`
   - `Creator Name`
   - `Full Name`
   - `Name`
   - `Company Name`
   - `Deal Name`
   - `Case Number`
   - `Invoice Number`

Examples:

- `https://www.youtube.com/@MikeMurphy` -> `yt-mikemurphy-001.md`
- `Creator Name = Jane Smith` -> `jane-smith-001.md`
- `Company Name = Acme Corp` -> `acme-corp-001.md`

### NEVER do these

- Do **NOT** default to `{entry_id}.md` for new documents
- Do **NOT** confuse entry documents with the `Notes` richtext field
- Do **NOT** create a markdown file without also inserting/updating the `documents` table row
- Do **NOT** write human-readable files and leave them orphaned from metadata

### Backward compatibility

Older workspaces may still have legacy `{entry_id}.md` files. Those can continue to work, but **new** entry documents should follow the human-readable naming convention above.

---

## Creating One Entry Document

Only create entry `.md` files when the user wants detailed prose for a specific entry or group of entries.

Example:

```bash
cat > {{WORKSPACE_PATH}}/marketing/influencer/yt-mikemurphy-001.md << 'MD'
# Draft Outreach Email

To: hello@mikemurphy.co
Subject: Partnership idea

Hi Mike,

I loved your AI Handyman breakdowns. DenchClaw is launching a workflow-native AI platform for builders who want serious control over execution, memory, and automation.

Would you be open to testing it and discussing a possible sponsorship?
MD
```

Then register it:

```sql
INSERT INTO documents (title, file_path, parent_object_id, entry_id)
VALUES (
  'Mike Murphy',
  'marketing/influencer/yt-mikemurphy-001.md',
  (SELECT id FROM objects WHERE name = 'influencer'),
  'yt-mikemurphy-001'
)
ON CONFLICT (file_path) DO UPDATE
SET title = excluded.title,
    parent_object_id = excluded.parent_object_id,
    entry_id = excluded.entry_id,
    updated_at = now();
```

---

## Batch Creating Entry Documents

When the user asks for docs for many entries, do **not** update the `Notes` field in SQL. Create markdown files plus `documents` rows.

### Workflow

1. Query entries and the fields needed to build filenames/titles
2. Derive a human-readable filename for each entry
3. Write one `.md` file per entry under the object directory
4. Insert/update one `documents` row per file

### Example: create docs for every influencer

```bash
duckdb {{WORKSPACE_PATH}}/workspace.duckdb -json "
SELECT
  entry_id,
  \"Creator Name\",
  \"Channel Name\",
  \"YouTube URL\"
FROM v_influencer
ORDER BY \"Creator Name\"
"
```

Then for each row:

```bash
# Example row:
# entry_id = yt-mikemurphy-001
# youtube url = https://www.youtube.com/@MikeMurphy

cat > {{WORKSPACE_PATH}}/marketing/influencer/yt-mikemurphy-001.md << 'MD'
# Influencer Notes

## Outreach draft

...
MD
```

Register each file:

```sql
INSERT INTO documents (title, file_path, parent_object_id, entry_id)
VALUES (
  'Mike Murphy',
  'marketing/influencer/yt-mikemurphy-001.md',
  (SELECT id FROM objects WHERE name = 'influencer'),
  'yt-mikemurphy-001'
)
ON CONFLICT (file_path) DO UPDATE
SET title = excluded.title,
    parent_object_id = excluded.parent_object_id,
    entry_id = excluded.entry_id,
    updated_at = now();
```

---

## Standalone Documents vs Entry Documents

Not every markdown file under an object directory is automatically an entry document.

- **Entry document**: has a corresponding `documents` row with `entry_id` set
- **Standalone document under an object**: has no `entry_id` link; it is just a nested document in that folder

Examples:

- `marketing/influencer/yt-mikemurphy-001.md` with `documents.entry_id = 'yt-mikemurphy-001'` -> entry document
- `marketing/influencer/outreach-playbook.md` with no `entry_id` -> standalone object-level document

If a markdown file is meant to be the entry page, always register it in `documents`.
