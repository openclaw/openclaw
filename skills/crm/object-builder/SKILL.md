---
name: object-builder
description: Full 3-step workflow for creating workspace objects (SQL → filesystem → verify), CRM patterns for common object types, kanban boards, and the post-mutation checklist.
metadata: { "openclaw": { "inject": true, "always": true, "emoji": "🏗️" } }
---

# CRM Object Builder

This skill covers creating and modifying workspace objects end-to-end. For DuckDB schema and SQL reference, see **duckdb-operations** (`crm/duckdb-operations/SKILL.md`). For workspace fundamentals, see the parent **crm** skill (`crm/SKILL.md`).

---

## Full Workflow: Create CRM Structure in One Shot

EVERY object creation MUST complete ALL THREE steps below. Never stop after the SQL.

**Step 1 — SQL: Create object + fields + view** (single exec call):

```sql
BEGIN TRANSACTION;

-- 1a. Create object
INSERT INTO objects (name, description, icon, default_view)
VALUES ('lead', 'Sales leads tracking', 'user-plus', 'table')
ON CONFLICT (name) DO NOTHING;

-- 1b. Create all fields
INSERT INTO fields (object_id, name, type, required, sort_order) VALUES
  ((SELECT id FROM objects WHERE name = 'lead'), 'Full Name', 'text', true, 0),
  ((SELECT id FROM objects WHERE name = 'lead'), 'Email Address', 'email', true, 1),
  ((SELECT id FROM objects WHERE name = 'lead'), 'Phone Number', 'phone', false, 2),
  ((SELECT id FROM objects WHERE name = 'lead'), 'Score', 'number', false, 4),
  ((SELECT id FROM objects WHERE name = 'lead'), 'Notes', 'richtext', false, 6)
ON CONFLICT (object_id, name) DO NOTHING;

INSERT INTO fields (object_id, name, type, enum_values, enum_colors, sort_order) VALUES
  ((SELECT id FROM objects WHERE name = 'lead'), 'Status', 'enum',
   '["New","Contacted","Qualified","Converted"]'::JSON,
   '["#94a3b8","#3b82f6","#f59e0b","#22c55e"]'::JSON, 3),
  ((SELECT id FROM objects WHERE name = 'lead'), 'Source', 'enum',
   '["Website","Referral","Cold Call","Social"]'::JSON, NULL, 5)
ON CONFLICT (object_id, name) DO NOTHING;

-- 1c. MANDATORY: auto-generate PIVOT view
CREATE OR REPLACE VIEW v_lead AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = (SELECT id FROM objects WHERE name = 'lead')
) ON field_name USING first(value);

COMMIT;
```

**Step 2 — Filesystem: Create object directory + .object.yaml** (exec call):

```bash
mkdir -p {{WORKSPACE_PATH}}/lead

# Query the object metadata from DuckDB to build .object.yaml
OBJ_ID=$(duckdb {{WORKSPACE_PATH}}/workspace.duckdb -noheader -list "SELECT id FROM objects WHERE name = 'lead'")
ENTRY_COUNT=$(duckdb {{WORKSPACE_PATH}}/workspace.duckdb -noheader -list "SELECT COUNT(*) FROM entries WHERE object_id = '$OBJ_ID'")

cat > {{WORKSPACE_PATH}}/lead/.object.yaml << 'YAML'
id: "<use actual $OBJ_ID>"
name: "lead"
description: "Sales leads tracking"
icon: "user-plus"
default_view: "table"
entry_count: <use actual $ENTRY_COUNT>
fields:
  - name: "Full Name"
    type: text
    required: true
  - name: "Email Address"
    type: email
    required: true
  - name: "Phone Number"
    type: phone
  - name: "Status"
    type: enum
    values: ["New", "Contacted", "Qualified", "Converted"]
  - name: "Score"
    type: number
  - name: "Source"
    type: enum
    values: ["Website", "Referral", "Cold Call", "Social"]
  - name: "Notes"
    type: richtext
YAML
```

**Step 3 — Verify**: Confirm both the view and filesystem exist:

```bash
# Verify view works
duckdb {{WORKSPACE_PATH}}/workspace.duckdb "SELECT COUNT(*) FROM v_lead"
# Verify .object.yaml exists
cat {{WORKSPACE_PATH}}/lead/.object.yaml
```

---

## Kanban Boards

When creating task/board objects, use `default_view = 'kanban'` and auto-create Status + Assigned To fields. Set `view_settings.kanbanField` to the enum field that defines columns. Remember: ALL THREE STEPS are required.

**Step 1 — SQL:**

```sql
BEGIN TRANSACTION;
INSERT INTO objects (name, description, icon, default_view)
VALUES ('task', 'Task tracking board', 'check-square', 'kanban')
ON CONFLICT (name) DO NOTHING;

-- Auto-create Status field with kanban-appropriate values
INSERT INTO fields (object_id, name, type, enum_values, enum_colors, sort_order)
VALUES ((SELECT id FROM objects WHERE name = 'task'), 'Status', 'enum',
  '["In Queue","In Progress","Done"]'::JSON,
  '["#94a3b8","#3b82f6","#22c55e"]'::JSON, 0)
ON CONFLICT (object_id, name) DO NOTHING;

-- Auto-create Assigned To field (user type)
INSERT INTO fields (object_id, name, type, sort_order)
VALUES ((SELECT id FROM objects WHERE name = 'task'), 'Assigned To', 'user', 1)
ON CONFLICT (object_id, name) DO NOTHING;

-- Auto-create default statuses
INSERT INTO statuses (object_id, name, color, sort_order, is_default) VALUES
  ((SELECT id FROM objects WHERE name = 'task'), 'In Queue', '#94a3b8', 0, true),
  ((SELECT id FROM objects WHERE name = 'task'), 'In Progress', '#3b82f6', 1, false),
  ((SELECT id FROM objects WHERE name = 'task'), 'Done', '#22c55e', 2, false)
ON CONFLICT (object_id, name) DO NOTHING;

CREATE OR REPLACE VIEW v_task AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = (SELECT id FROM objects WHERE name = 'task')
) ON field_name USING first(value);

COMMIT;
```

**Step 2 — Filesystem (MANDATORY):**

```bash
mkdir -p {{WORKSPACE_PATH}}/task
cat > {{WORKSPACE_PATH}}/task/.object.yaml << 'YAML'
id: "<query from DuckDB>"
name: "task"
description: "Task tracking board"
icon: "check-square"
default_view: "kanban"
entry_count: 0
view_settings:
  kanbanField: "Status"
fields:
  - name: "Status"
    type: enum
    values: ["In Queue", "In Progress", "Done"]
  - name: "Assigned To"
    type: user
YAML
```

**Step 3 — Verify:** `duckdb {{WORKSPACE_PATH}}/workspace.duckdb "SELECT COUNT(*) FROM v_task"` and `cat {{WORKSPACE_PATH}}/task/.object.yaml`.

---

## CRM Patterns

### Contact/Customer

- Full Name (text, required), Email Address (email, required), Phone Number (phone), Company (relation to company object), Notes (richtext)
- Universal pattern for clients, customers, patients, members

### Lead/Prospect

- Full Name (text, required), Email Address (email, required), Phone Number (phone), Status (enum: New/Contacted/Qualified/Converted), Source (enum: Website/Referral/Cold Call/Social), Score (number), Assigned To (user), Notes (richtext)
- Sales, legal intake, real estate prospects

### Company/Organization

- Company Name (text, required), Industry (enum), Website (text), Type (enum: Client/Partner/Vendor), Relationship Status (enum), Notes (richtext)
- B2B relationships, vendor management

### Deal/Opportunity

- Deal Name (text, required), Amount (number), Stage (enum: Discovery/Proposal/Negotiation/Closed Won/Closed Lost), Close Date (date), Probability (number), Primary Contact (relation), Assigned To (user), Notes (richtext)
- Sales pipeline, project bids

### Case/Project

- Case Number (text, required), Title (text, required), Client (relation), Status (enum: Open/In Progress/Closed), Priority (enum: Low/Medium/High/Urgent), Due Date (date), Assigned To (user), Notes (richtext)
- Legal cases, client projects

### Property/Asset

- Address (text, required), Property Type (enum), Price (number), Status (enum: Available/Under Contract/Sold), Square Footage (number), Bedrooms (number), Notes (richtext)
- Real estate listings, asset management

### Task/Activity (use kanban)

- Title (text, required), Description (text), Assigned To (user), Due Date (date), Status (enum: In Queue/In Progress/Done), Priority (enum: Low/Medium/High), Notes (richtext)
- Use `default_view = 'kanban'` — auto-creates Status and Assigned To fields

---

## Post-Mutation Checklist (MANDATORY)

You MUST complete ALL steps below after ANY schema mutation (create/update/delete object, field, or entry). Do NOT skip any step. Do NOT consider the operation complete until all steps are done.

### After creating or modifying an OBJECT or its FIELDS:

- [ ] `CREATE OR REPLACE VIEW v_{object_name}` — regenerate the PIVOT view
- [ ] `mkdir -p {{WORKSPACE_PATH}}/{object_name}/` — create the object directory
- [ ] Write `{{WORKSPACE_PATH}}/{object_name}/.object.yaml` — metadata projection with id, name, description, icon, default_view, entry_count, and full field list
- [ ] If object has a `parent_document_id`, place directory inside the parent document's directory
- [ ] Update `WORKSPACE.md` if it exists

### After adding or updating ENTRIES:

- [ ] Update `entry_count` in the corresponding `.object.yaml`
- [ ] Verify the view returns correct data: `SELECT * FROM v_{object} LIMIT 5`

### After deleting an OBJECT:

- [ ] `DROP VIEW IF EXISTS v_{object_name}` — remove the view
- [ ] `rm -rf {{WORKSPACE_PATH}}/{object_name}/` — remove the directory (unless it contains nested documents that need relocating)
- [ ] Update `WORKSPACE.md`

### After creating or modifying a DOCUMENT:

- [ ] Write the `.md` file to the correct path in `{{WORKSPACE_PATH}}/**`
- [ ] `INSERT INTO documents` — ensure metadata row exists with correct `file_path`, `parent_id`, or `parent_object_id`

These steps ensure the filesystem always mirrors DuckDB. The sidebar depends on `.object.yaml` files — if they are missing, objects will not appear.
