---
name: duckdb-operations
description: DuckDB schema initialization, field types reference, auto-generated PIVOT views, and SQL CRUD operations for workspace objects, fields, and entries.
metadata: { "openclaw": { "inject": true, "always": true, "emoji": "🗄️" } }
---

# CRM DuckDB Operations

This skill covers DuckDB schema, field types, PIVOT views, and SQL CRUD. For workspace fundamentals, naming conventions, and startup, see the parent **crm** skill (`crm/SKILL.md`).

---

## DuckDB Schema

Initialize via `exec` with `duckdb {{WORKSPACE_PATH}}/workspace.duckdb`:

```sql
-- Optional: nanoid32 macro (generates 32-char IDs matching Supabase format)
-- Not required — gen_random_uuid()::VARCHAR is the default for all tables.
CREATE OR REPLACE MACRO nanoid32() AS (
  SELECT string_agg(
    substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-',
      (floor(random() * 64) + 1)::int, 1), '')
  FROM generate_series(1, 32)
);

CREATE TABLE IF NOT EXISTS objects (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  name VARCHAR NOT NULL,
  description VARCHAR,
  icon VARCHAR,
  default_view VARCHAR DEFAULT 'table',
  parent_document_id VARCHAR,
  sort_order INTEGER DEFAULT 0,
  source_app VARCHAR,
  immutable BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS fields (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  object_id VARCHAR NOT NULL REFERENCES objects(id),
  name VARCHAR NOT NULL,
  description VARCHAR,
  type VARCHAR NOT NULL,
  required BOOLEAN DEFAULT false,
  default_value VARCHAR,
  related_object_id VARCHAR REFERENCES objects(id),
  relationship_type VARCHAR,
  enum_values JSON,
  enum_colors JSON,
  enum_multiple BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(object_id, name)
);

CREATE TABLE IF NOT EXISTS entries (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  object_id VARCHAR NOT NULL REFERENCES objects(id),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entry_fields (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  entry_id VARCHAR NOT NULL REFERENCES entries(id),
  field_id VARCHAR NOT NULL REFERENCES fields(id),
  value VARCHAR,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(entry_id, field_id)
);

CREATE TABLE IF NOT EXISTS statuses (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  object_id VARCHAR NOT NULL REFERENCES objects(id),
  name VARCHAR NOT NULL,
  color VARCHAR DEFAULT '#94a3b8',
  sort_order INTEGER DEFAULT 0,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(object_id, name)
);

CREATE TABLE IF NOT EXISTS documents (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  title VARCHAR DEFAULT 'Untitled',
  icon VARCHAR,
  cover_image VARCHAR,
  file_path VARCHAR NOT NULL UNIQUE,
  parent_id VARCHAR REFERENCES documents(id),
  parent_object_id VARCHAR REFERENCES objects(id),
  entry_id VARCHAR REFERENCES entries(id),
  sort_order INTEGER DEFAULT 0,
  is_published BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_runs (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  action_id VARCHAR NOT NULL,
  field_id VARCHAR NOT NULL,
  entry_id VARCHAR NOT NULL,
  object_id VARCHAR NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  result VARCHAR,
  error VARCHAR,
  stdout VARCHAR,
  exit_code INTEGER
);
```

### ID Generation

All ID columns default to `gen_random_uuid()::VARCHAR`. You can also use `nanoid32()` if the macro is loaded. When inserting manually, always generate an ID — never use a placeholder.

For entry detail markdown pages, `documents.entry_id` links a document row to a specific CRM entry while `file_path` stores the human-readable markdown path (for example `marketing/influencer/yt-mikemurphy-001.md`).

---

## Auto-Generated PIVOT Views

After every object or field mutation, regenerate the PIVOT view for each affected object. Views are stored queries (zero data duplication) that make the EAV pattern invisible.

**CRITICAL: Always use the `IN (...)` clause to list field names explicitly.** Without it, column names depend on whatever data happens to exist, causing unpredictable view schemas and broken queries.

```sql
-- CORRECT: list all non-action field names in the IN clause
CREATE OR REPLACE VIEW v_lead AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = (SELECT id FROM objects WHERE name = 'lead')
    AND f.type != 'action'
) ON field_name IN ('Full Name', 'Email Address', 'Phone Number', 'Status', 'Score', 'Source', 'Notes') USING first(value);
```

Naming convention: `v_{object_name}` (e.g., `v_lead`, `v_company`, `v_people`).

**To get the field list for the `IN` clause**, query non-action fields first:

```sql
SELECT name FROM fields
WHERE object_id = (SELECT id FROM objects WHERE name = 'lead')
  AND type != 'action'
ORDER BY sort_order;
```

Then construct the PIVOT view with those names in the `IN (...)`.

Now query like a normal table:

```sql
SELECT * FROM v_lead WHERE "Status" = 'New' ORDER BY created_at DESC LIMIT 50;
SELECT "Status", COUNT(*) FROM v_lead GROUP BY "Status";
SELECT * FROM v_lead WHERE "Email Address" LIKE '%@gmail.com';
```

---

## Field Types Reference

| Type     | Description                           | Storage                   | Query Cast  | API Create |
| -------- | ------------------------------------- | ------------------------- | ----------- | ---------- |
| text     | General text, names, descriptions     | VARCHAR                   | none        | yes |
| email    | Email addresses (validated)           | VARCHAR                   | none        | yes |
| phone    | Phone numbers (normalized)            | VARCHAR                   | none        | yes |
| url      | URLs / website addresses              | VARCHAR                   | none        | yes |
| number   | Numeric values (prices, scores)       | VARCHAR                   | `::NUMERIC` | yes |
| boolean  | Yes/no flags                          | "true"/"false"            | `= 'true'`  | yes |
| date     | ISO 8601 dates                        | VARCHAR                   | `::DATE`    | yes |
| richtext | Rich text for Notes fields            | VARCHAR                   | none        | yes |
| file     | File attachments                      | VARCHAR (file path/URL)   | none        | yes |
| user     | Member ID from workspace_context.yaml | VARCHAR                   | none        | SQL only |
| enum     | Dropdown with predefined values       | VARCHAR                   | none        | yes |
| relation | Link to entry in another object       | VARCHAR (entry ID)        | none        | SQL only |
| tags     | Free-form string array (labels, tags) | VARCHAR (JSON array str)  | none        | yes |
| action   | Executable buttons (server-side scripts) | No entry_fields values (config in `default_value`) | N/A — excluded from PIVOT | yes |

**"API Create" column**: "yes" means the field can be created via `POST /api/workspace/objects/{name}/fields`. "SQL only" means you must create it directly in DuckDB (the API endpoint does not accept `user` or `relation` types).

### System Timestamp Columns (Always Present)

Every entry row always has:

- `created_at` (TIMESTAMPTZ in `entries`)
- `updated_at` (TIMESTAMPTZ in `entries`)

Important:

- These are system columns, so they are NOT listed in the `fields` table.
- If `SELECT * FROM fields` shows no date fields, you still have `created_at` and `updated_at`.
- Use these as date fallbacks for calendar/timeline views and date-based natural language requests.

### Field Type Details

**user fields**: Resolve member name to ID from `workspace_context.yaml` `members` list BEFORE inserting. User fields store IDs like `usr_abc123`, NOT names.

**enum fields**: Field definition stores `enum_values` as JSON array. Entry stores the selected value string. `enum_multiple = true` for multi-select (value stored as JSON array string).

**relation fields**: Field stores `related_object_id` (the ID of the target object) and `relationship_type` (`many_to_one` for single select, `many_to_many` for multi-select). Entry field value stores the related entry ID (or JSON array of IDs for many-to-many). Relation fields can only be created via direct DuckDB SQL (not the API). The UI renders them as a searchable dropdown of entries from the related object.

Creating a relation field (SQL — the only way):

```sql
INSERT INTO fields (object_id, name, type, related_object_id, relationship_type, sort_order)
VALUES (
  (SELECT id FROM objects WHERE name = 'people'),
  'Company',
  'relation',
  (SELECT id FROM objects WHERE name = 'company'),
  'many_to_one',
  3
) ON CONFLICT (object_id, name) DO NOTHING;
```

Setting a relation value on an entry:

```sql
INSERT INTO entry_fields (entry_id, field_id, value)
VALUES (
  '<person_entry_id>',
  (SELECT id FROM fields WHERE object_id = (SELECT id FROM objects WHERE name = 'people') AND name = 'Company'),
  '<company_entry_id>'
) ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value, updated_at = now();
```

For `many_to_many`, store a JSON array of entry IDs: `'["id1","id2","id3"]'`.

**tags fields**: Free-form string arrays for labels, domains, skills, keywords, etc. Value stored as JSON array string: `'["tag1","tag2","tag3"]'`. No predefined values — users can type any value. Displayed as removable chips in the UI.

---

## SQL Operations Reference

All operations use `exec` with `duckdb {{WORKSPACE_PATH}}/workspace.duckdb`. Batch related SQL in a single exec call with transactions.

### Create Object

```sql
INSERT INTO objects (name, description, icon, default_view)
VALUES ('lead', 'Sales leads tracking', 'user-plus', 'table')
ON CONFLICT (name) DO NOTHING RETURNING *;
```

### Create Fields

```sql
INSERT INTO fields (object_id, name, type, required, sort_order)
VALUES
  ((SELECT id FROM objects WHERE name = 'lead'), 'Full Name', 'text', true, 0),
  ((SELECT id FROM objects WHERE name = 'lead'), 'Email Address', 'email', true, 1),
  ((SELECT id FROM objects WHERE name = 'lead'), 'Phone Number', 'phone', false, 2)
ON CONFLICT (object_id, name) DO NOTHING;
```

### Create Enum Field

```sql
INSERT INTO fields (object_id, name, type, enum_values, enum_colors, sort_order)
VALUES (
  (SELECT id FROM objects WHERE name = 'lead'), 'Status', 'enum',
  '["New","Contacted","Qualified","Converted"]'::JSON,
  '["#94a3b8","#3b82f6","#f59e0b","#22c55e"]'::JSON, 3
) ON CONFLICT (object_id, name) DO NOTHING;
```

### Create Relation Field

Relation fields link entries across objects. **You MUST create these via SQL** — the API does not support `relation` type.

```sql
-- Link people → company (many people belong to one company)
INSERT INTO fields (object_id, name, type, related_object_id, relationship_type, sort_order)
VALUES (
  (SELECT id FROM objects WHERE name = 'people'),
  'Company',
  'relation',
  (SELECT id FROM objects WHERE name = 'company'),
  'many_to_one',
  3
) ON CONFLICT (object_id, name) DO NOTHING;

-- Link deal → contact (each deal has a primary contact)
INSERT INTO fields (object_id, name, type, related_object_id, relationship_type, sort_order)
VALUES (
  (SELECT id FROM objects WHERE name = 'deal'),
  'Primary Contact',
  'relation',
  (SELECT id FROM objects WHERE name = 'people'),
  'many_to_one',
  5
) ON CONFLICT (object_id, name) DO NOTHING;

-- Link project → team members (many-to-many)
INSERT INTO fields (object_id, name, type, related_object_id, relationship_type, sort_order)
VALUES (
  (SELECT id FROM objects WHERE name = 'project'),
  'Team Members',
  'relation',
  (SELECT id FROM objects WHERE name = 'people'),
  'many_to_many',
  4
) ON CONFLICT (object_id, name) DO NOTHING;
```

### Create Entry with Field Values

**IMPORTANT**: The `duckdb` CLI cannot capture `RETURNING` output and reuse it in the same exec call. Instead, pre-generate the entry ID so both statements can reference it:

```sql
BEGIN TRANSACTION;

-- Pre-generate the entry ID so we can use it in both INSERT statements
INSERT INTO entries (id, object_id)
VALUES (
  (SELECT gen_random_uuid()::VARCHAR),
  (SELECT id FROM objects WHERE name = 'lead')
);

-- Get the ID we just inserted (last entry for this object)
INSERT INTO entry_fields (entry_id, field_id, value) VALUES
  ((SELECT id FROM entries WHERE object_id = (SELECT id FROM objects WHERE name = 'lead') ORDER BY created_at DESC LIMIT 1),
   (SELECT id FROM fields WHERE object_id = (SELECT id FROM objects WHERE name = 'lead') AND name = 'Full Name'),
   'Jane Smith'),
  ((SELECT id FROM entries WHERE object_id = (SELECT id FROM objects WHERE name = 'lead') ORDER BY created_at DESC LIMIT 1),
   (SELECT id FROM fields WHERE object_id = (SELECT id FROM objects WHERE name = 'lead') AND name = 'Email Address'),
   'jane@example.com'),
  ((SELECT id FROM entries WHERE object_id = (SELECT id FROM objects WHERE name = 'lead') ORDER BY created_at DESC LIMIT 1),
   (SELECT id FROM fields WHERE object_id = (SELECT id FROM objects WHERE name = 'lead') AND name = 'Status'),
   'New')
ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value, updated_at = now();

COMMIT;
```

**Alternative (cleaner for multiple entries)**: Query the object_id and field_ids first, then use literal IDs:

```bash
OBJ_ID=$(duckdb {{WORKSPACE_PATH}}/workspace.duckdb -noheader -list "SELECT id FROM objects WHERE name = 'lead'")
FLD_NAME=$(duckdb {{WORKSPACE_PATH}}/workspace.duckdb -noheader -list "SELECT id FROM fields WHERE object_id = '$OBJ_ID' AND name = 'Full Name'")
FLD_EMAIL=$(duckdb {{WORKSPACE_PATH}}/workspace.duckdb -noheader -list "SELECT id FROM fields WHERE object_id = '$OBJ_ID' AND name = 'Email Address'")
FLD_STATUS=$(duckdb {{WORKSPACE_PATH}}/workspace.duckdb -noheader -list "SELECT id FROM fields WHERE object_id = '$OBJ_ID' AND name = 'Status'")
ENTRY_ID=$(duckdb {{WORKSPACE_PATH}}/workspace.duckdb -noheader -list "SELECT gen_random_uuid()::VARCHAR")

duckdb {{WORKSPACE_PATH}}/workspace.duckdb "
BEGIN TRANSACTION;
INSERT INTO entries (id, object_id) VALUES ('$ENTRY_ID', '$OBJ_ID');
INSERT INTO entry_fields (entry_id, field_id, value) VALUES
  ('$ENTRY_ID', '$FLD_NAME', 'Jane Smith'),
  ('$ENTRY_ID', '$FLD_EMAIL', 'jane@example.com'),
  ('$ENTRY_ID', '$FLD_STATUS', 'New')
ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value, updated_at = now();
COMMIT;
"
```

### Search Entries (via view)

```sql
-- Simple search
SELECT * FROM v_leads WHERE "Full Name" ILIKE '%john%';

-- Filter by field
SELECT * FROM v_leads WHERE "Status" = 'New' ORDER BY created_at DESC;

-- Aggregation
SELECT "Status", COUNT(*) as count FROM v_leads GROUP BY "Status";

-- Pagination
SELECT * FROM v_leads ORDER BY created_at DESC LIMIT 20 OFFSET 0;
```

### Update Entry

```sql
INSERT INTO entry_fields (entry_id, field_id, value)
VALUES ('<entry_id>', (SELECT id FROM fields WHERE object_id = '<obj_id>' AND name = 'Status'), 'Qualified')
ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value, updated_at = now();
```

### Delete (with cascade)

```sql
-- Delete entry (cascades to entry_fields)
DELETE FROM entries WHERE id = '<entry_id>';

-- Delete field (cascades to entry_fields)
DELETE FROM fields WHERE id = '<field_id>';

-- Delete object (cascades to fields, entries, entry_fields) — check immutable first!
DELETE FROM objects WHERE id = '<obj_id>' AND immutable = false;
```

### Bulk Import from CSV

CRM data follows the EAV pattern (entries + entry_fields), so you can't `COPY` directly into `entries`. Instead, load the CSV into a temp table, then insert into entries and entry_fields:

```sql
-- 1. Load CSV into a temporary staging table
CREATE TEMP TABLE staging AS SELECT * FROM read_csv_auto('{{WORKSPACE_PATH}}/exports/import.csv');

-- 2. Get object and field IDs
-- (Assumes CSV columns match field names exactly)

-- 3. For each row, create an entry and insert field values
-- Use a script/loop for this — DuckDB doesn't have procedural FOR loops.
```

For bulk import, prefer a shell script that reads the CSV row by row:

```bash
OBJ_ID=$(duckdb {{WORKSPACE_PATH}}/workspace.duckdb -noheader -list "SELECT id FROM objects WHERE name = 'lead'")

# Read CSV and insert each row
tail -n +2 {{WORKSPACE_PATH}}/exports/import.csv | while IFS=',' read -r name email status; do
  ENTRY_ID=$(duckdb {{WORKSPACE_PATH}}/workspace.duckdb -noheader -list "SELECT gen_random_uuid()::VARCHAR")
  duckdb {{WORKSPACE_PATH}}/workspace.duckdb "
    BEGIN TRANSACTION;
    INSERT INTO entries (id, object_id) VALUES ('$ENTRY_ID', '$OBJ_ID');
    INSERT INTO entry_fields (entry_id, field_id, value) VALUES
      ('$ENTRY_ID', (SELECT id FROM fields WHERE object_id = '$OBJ_ID' AND name = 'Full Name'), '${name//\'/\'\'}'),
      ('$ENTRY_ID', (SELECT id FROM fields WHERE object_id = '$OBJ_ID' AND name = 'Email Address'), '${email//\'/\'\'}'),
      ('$ENTRY_ID', (SELECT id FROM fields WHERE object_id = '$OBJ_ID' AND name = 'Status'), '${status//\'/\'\'}')
    ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value;
    COMMIT;
  "
done
```

### Export to CSV

```sql
COPY (SELECT * FROM v_lead) TO '{{WORKSPACE_PATH}}/exports/lead.csv' (HEADER true);
```

---

## Common DuckDB Pitfalls

These are the most common reasons DuckDB commands fail on the first try. Read these BEFORE writing any SQL.

### 1. Field names with spaces MUST be double-quoted

```sql
-- WRONG: unquoted field name with space
SELECT Full Name FROM v_lead;

-- CORRECT: double-quote field names that contain spaces
SELECT "Full Name" FROM v_lead;
```

This applies everywhere: `SELECT`, `WHERE`, `GROUP BY`, `ORDER BY`, PIVOT `IN (...)`.

### 2. Use `BEGIN TRANSACTION` not `BEGIN`

```sql
-- WRONG:
BEGIN;

-- CORRECT:
BEGIN TRANSACTION;
```

### 3. Single quotes inside string values must be escaped with `''`

```sql
-- WRONG: unescaped apostrophe
INSERT INTO entry_fields (...) VALUES (..., 'O'Brien Corp');

-- CORRECT: doubled single quote
INSERT INTO entry_fields (...) VALUES (..., 'O''Brien Corp');
```

### 4. `::JSON` cast requires valid JSON

```sql
-- WRONG: not valid JSON (missing quotes around strings)
'[New, Old]'::JSON

-- CORRECT: valid JSON array
'["New","Old"]'::JSON
```

### 5. PIVOT view with explicit field list prevents schema drift

```sql
-- WRONG: columns depend on whatever data exists
PIVOT (...) ON field_name USING first(value);

-- CORRECT: explicit field list ensures deterministic columns
PIVOT (...) ON field_name IN ('Full Name', 'Email Address', 'Status') USING first(value);
```

### 6. Exclude action fields from PIVOT views

Action fields have no entry_fields values. Include `AND f.type != 'action'` in the WHERE clause or simply exclude them from the `IN (...)` list.

### 7. Shell escaping when running `duckdb` CLI

When running SQL via the `duckdb` CLI, single quotes in SQL conflict with shell quoting. Use double-quote wrapping for the SQL argument:

```bash
# WRONG: shell interprets the inner single quotes
duckdb workspace.duckdb 'SELECT * FROM v_lead WHERE "Status" = 'New''

# CORRECT: use double-quote wrapper
duckdb workspace.duckdb "SELECT * FROM v_lead WHERE \"Status\" = 'New'"
```

### 8. DuckDB may be locked by another process

If you get a "database is locked" error, another process (the web server, another CLI call) has the DB open. For read-only queries, retry or use `-readonly`:

```bash
duckdb -readonly {{WORKSPACE_PATH}}/workspace.duckdb "SELECT COUNT(*) FROM entries"
```

### 9. Always use `ON CONFLICT` for idempotent operations

Avoid `UNIQUE constraint` errors by using upsert patterns:

```sql
-- For objects:
INSERT INTO objects (...) VALUES (...) ON CONFLICT (name) DO NOTHING;

-- For fields:
INSERT INTO fields (...) VALUES (...) ON CONFLICT (object_id, name) DO NOTHING;

-- For entry field values:
INSERT INTO entry_fields (...) VALUES (...)
ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value, updated_at = now();
```

### 10. Empty PIVOT views are not errors

If an object has no entries, the PIVOT view will return 0 rows but still be created successfully. This is expected behavior — do not treat it as a failure.
