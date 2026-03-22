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
-- Nanoid 32 macro: generates IDs matching the CRM's Supabase nanoid format
CREATE OR REPLACE MACRO nanoid32() AS (
  SELECT string_agg(
    substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-',
      (floor(random() * 64) + 1)::int, 1), '')
  FROM generate_series(1, 32)
);

CREATE TABLE IF NOT EXISTS objects (
  id VARCHAR PRIMARY KEY DEFAULT (nanoid32()),
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
  id VARCHAR PRIMARY KEY DEFAULT (nanoid32()),
  object_id VARCHAR NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  name VARCHAR NOT NULL,
  description VARCHAR,
  type VARCHAR NOT NULL,
  required BOOLEAN DEFAULT false,
  default_value VARCHAR,
  related_object_id VARCHAR REFERENCES objects(id) ON DELETE SET NULL,
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
  id VARCHAR PRIMARY KEY DEFAULT (nanoid32()),
  object_id VARCHAR NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entry_fields (
  id VARCHAR PRIMARY KEY DEFAULT (nanoid32()),
  entry_id VARCHAR NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  field_id VARCHAR NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  value VARCHAR,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(entry_id, field_id)
);

CREATE TABLE IF NOT EXISTS statuses (
  id VARCHAR PRIMARY KEY DEFAULT (nanoid32()),
  object_id VARCHAR NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  name VARCHAR NOT NULL,
  color VARCHAR DEFAULT '#94a3b8',
  sort_order INTEGER DEFAULT 0,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(object_id, name)
);

CREATE TABLE IF NOT EXISTS documents (
  id VARCHAR PRIMARY KEY DEFAULT (nanoid32()),
  title VARCHAR DEFAULT 'Untitled',
  icon VARCHAR,
  cover_image VARCHAR,
  file_path VARCHAR NOT NULL UNIQUE,
  parent_id VARCHAR REFERENCES documents(id) ON DELETE CASCADE,
  parent_object_id VARCHAR REFERENCES objects(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  is_published BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_runs (
  id VARCHAR PRIMARY KEY DEFAULT (nanoid32()),
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

INSTALL fts; LOAD fts;
```

### ALL ID fields must be a nanoid ID.

---

## Auto-Generated PIVOT Views

After every object or field mutation, regenerate the PIVOT view for each affected object. Views are stored queries (zero data duplication) that make the EAV pattern invisible:

```sql
-- Example: auto-generated view for "leads" object
CREATE OR REPLACE VIEW v_leads AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = (SELECT id FROM objects WHERE name = 'leads')
) ON field_name USING first(value);
```

Naming convention: `v_{object_name}` (e.g., `v_leads`, `v_companies`, `v_people`).

Now query like a normal table:

```sql
SELECT * FROM v_leads WHERE "Status" = 'New' ORDER BY created_at DESC LIMIT 50;
SELECT "Status", COUNT(*) FROM v_leads GROUP BY "Status";
SELECT * FROM v_leads WHERE "Email Address" LIKE '%@gmail.com';
```

---

## Field Types Reference

| Type     | Description                           | Storage                   | Query Cast  |
| -------- | ------------------------------------- | ------------------------- | ----------- |
| text     | General text, names, descriptions     | VARCHAR                   | none        |
| email    | Email addresses (validated)           | VARCHAR                   | none        |
| phone    | Phone numbers (normalized)            | VARCHAR                   | none        |
| number   | Numeric values (prices, scores)       | VARCHAR                   | `::NUMERIC` |
| boolean  | Yes/no flags                          | "true"/"false"            | `= 'true'`  |
| date     | ISO 8601 dates                        | VARCHAR                   | `::DATE`    |
| richtext | Rich text for Notes fields            | VARCHAR                   | none        |
| user     | Member ID from workspace_context.yaml | VARCHAR                   | none        |
| enum     | Dropdown with predefined values       | VARCHAR                   | none        |
| relation | Link to entry in another object       | VARCHAR (entry ID)        | none        |
| tags     | Free-form string array (labels, tags) | VARCHAR (JSON array str)  | none        |
| action   | Executable buttons (server-side scripts) | No entry_fields values (config in `default_value`) | N/A — excluded from PIVOT |

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

**relation fields**: Field stores `related_object_id` and `relationship_type`. Entry stores the related entry ID. `many_to_one` for single select, `many_to_many` for multi-select (JSON array of IDs).

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

### Create Entry with Field Values

```sql
BEGIN TRANSACTION;
INSERT INTO entries (object_id) VALUES ((SELECT id FROM objects WHERE name = 'lead')) RETURNING id;
-- Use the returned entry id:
INSERT INTO entry_fields (entry_id, field_id, value) VALUES
  ('<entry_id>', (SELECT id FROM fields WHERE object_id = (SELECT id FROM objects WHERE name = 'lead') AND name = 'Full Name'), 'Jane Smith'),
  ('<entry_id>', (SELECT id FROM fields WHERE object_id = (SELECT id FROM objects WHERE name = 'lead') AND name = 'Email Address'), 'jane@example.com'),
  ('<entry_id>', (SELECT id FROM fields WHERE object_id = (SELECT id FROM objects WHERE name = 'lead') AND name = 'Status'), 'New');
COMMIT;
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

```sql
COPY entries FROM '{{WORKSPACE_PATH}}/exports/import.csv' (AUTO_DETECT true);
```

### Export to CSV

```sql
COPY (SELECT * FROM v_leads) TO '{{WORKSPACE_PATH}}/exports/leads.csv' (HEADER true);
```
