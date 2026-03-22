---
name: documents
description: Document management with markdown files, cross-nesting between documents and objects, and optional per-entry detail pages.
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

## Entry Detail Pages (Optional Markdown Files)

Each entry in an object can have an optional markdown file that acts as a detail page (like a Notion row page). The file is stored inside the object's directory at `{{WORKSPACE_PATH}}/{object_name}/{entry_id}.md`.

**Key rules:**

- Entry `.md` files are **optional** — they are only created when the user writes content via the entry detail panel in the UI.
- You do NOT need to create `.md` files for every entry during seeding. Only create them when you want to add detailed notes, descriptions, or documentation for a specific entry.
- The UI automatically shows an empty markdown editor for entries without a `.md` file, and creates the file on first write.
- Entry `.md` files are plain markdown (no frontmatter required). The filename must be exactly `{entry_id}.md`.

**When to create entry `.md` files during seeding:**

- For entries that have rich descriptions or meeting notes
- For entries that need SOPs, playbooks, or documentation attached
- For key entries like important leads, major projects, or critical tasks

**Example:**

```bash
# Only if you want to add detailed notes for this specific entry
cat > {{WORKSPACE_PATH}}/lead/abc123.md << 'MD'
# Meeting Notes - Acme Corp

Met with John on 2026-03-15. Key takeaways:

- Interested in enterprise plan
- Budget approved for Q2
- Follow up next week with pricing proposal
MD
```
