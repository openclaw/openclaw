---
name: views-filters
description: .object.yaml format and template, view type settings (kanban, calendar, timeline, gallery, list), saved views with filter operators, and date format rules.
metadata: { "openclaw": { "inject": true, "always": true, "emoji": "👁️" } }
---

# CRM Views & Filters

This skill covers `.object.yaml` format, view types, saved views, and filter operators. For workspace fundamentals, see the parent **crm** skill (`crm/SKILL.md`). For creating objects end-to-end, see **object-builder** (`crm/object-builder/SKILL.md`).

---

## .object.yaml Format

Every object directory MUST contain a `.object.yaml` file. This is a lightweight metadata projection that the sidebar reads. Generate it from DuckDB after creating or modifying any object.

Template:

```yaml
id: "<object_id from DuckDB>"
name: "<object_name>"
description: "<object_description>"
icon: "<lucide_icon_name>"
default_view: "<table|kanban|calendar|timeline|gallery|list>"
entry_count: <number>
fields:
  - name: "Full Name"
    type: text
    required: true
  - name: "Email Address"
    type: email
    required: true
  - name: "Status"
    type: enum
    values: ["New", "Contacted", "Qualified", "Converted"]
  - name: "Assigned To"
    type: user
```

### View Type Settings

`.object.yaml` supports a `view_settings` block for configuring how each view type renders. These settings serve as defaults; individual saved views can override them.

```yaml
view_settings:
  kanbanField: "Status" # enum field to group kanban columns by
  calendarDateField: "Due Date" # date field for calendar events
  calendarEndDateField: "End Date" # optional: end date for multi-day events
  calendarMode: "month" # day | week | month | year
  timelineStartField: "Start Date" # date field for timeline bar start
  timelineEndField: "End Date" # date field for timeline bar end
  timelineGroupField: "Status" # optional: enum field to group timeline rows
  timelineZoom: "week" # day | week | month | quarter
  galleryTitleField: "Name" # text field for gallery card title
  galleryCoverField: "Image" # optional: field for gallery card cover
  listTitleField: "Name" # text field for list row title
  listSubtitleField: "Description" # optional: text field for list row subtitle
  column_widths: # optional: custom column widths in pixels (persisted on drag-resize)
    Full Name: 250
    Email Address: 200
    Status: 150
```

If an object has no custom date field, you MUST fall back to system timestamps:

- `created_at` (always available on entries)
- `updated_at` (always available on entries)

These can be used in `calendarDateField`, `timelineStartField`, `timelineEndField`, filters, sorts, and date-based user requests.

**View types:**

| View Type  | Best for                        | Required settings           |
| ---------- | ------------------------------- | --------------------------- |
| `table`    | Spreadsheet-like data editing   | None (default)              |
| `kanban`   | Status-based boards             | `kanbanField` (enum)        |
| `calendar` | Date-based entries              | `calendarDateField` (date)  |
| `timeline` | Gantt charts / project planning | `timelineStartField` (date) |
| `gallery`  | Visual card grid                | None (auto-detects title)   |
| `list`     | Simple compact list             | None (auto-detects title)   |

When creating objects with specific use cases, set `default_view` and `view_settings` appropriately:

- Task boards: `default_view: "kanban"` + `view_settings.kanbanField: "Status"`
- Event calendars: `default_view: "calendar"` + `view_settings.calendarDateField: "Date"`
- Project timelines: `default_view: "timeline"` + `view_settings.timelineStartField: "Start Date"` + `view_settings.timelineEndField: "End Date"`

---

## Saved Views and Filters

`.object.yaml` supports a `views` section for saved filter views. These views appear in the UI filter bar and can be created or modified by the agent to immediately change what the user sees (the UI live-reloads via the file watcher).

Default behavior:

- When the user asks to filter, narrow, segment, show only, or hide entries in the UI, create or update a saved view and set `active_view` even if they did not explicitly ask to "create a view".
- For table views, `columns` is optional. Omit it by default. If `columns` is absent, the UI shows the default/all columns for that view.
- `views[].columns` controls visibility only, not display order.
- Only include `columns` when the user explicitly asks for a specific visible subset of columns.
- If the user asks to reorder columns, update the object's field `sort_order` in DuckDB and regenerate the top-level `.object.yaml` `fields` list in the same order.

### Filter Operators by Field Type

| Field Type          | Operators                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------ |
| text/richtext/email | contains, not_contains, equals, not_equals, starts_with, ends_with, is_empty, is_not_empty |
| number              | eq, neq, gt, gte, lt, lte, between, is_empty, is_not_empty                                 |
| date                | on, before, after, date_between, relative_past, relative_next, is_empty, is_not_empty      |
| enum                | is, is_not, is_any_of, is_none_of, is_empty, is_not_empty                                  |
| boolean             | is_true, is_false, is_empty, is_not_empty                                                  |
| relation/user       | has_any, has_none, has_all, is_empty, is_not_empty                                         |
| tags                | contains, not_contains, is_empty, is_not_empty                                             |

**System timestamp columns are always available on every object entry**:

- `created_at` (date/time)
- `updated_at` (date/time)

Treat them as date fields for filtering, sorting, calendar, and timeline operations even when `fields` has no `date` type columns.

### Views Template

Append to `.object.yaml`:

```yaml
views:
  - name: "Active deals"
    view_type: "table"
    filters:
      id: root
      conjunction: and
      rules:
        - id: f1
          field: status
          operator: is_any_of
          value:
            - "Negotiating"
            - "Proposal sent"
        - id: f2
          field: amount
          operator: gte
          value: 10000
    sort:
      - field: updated_at
        direction: desc

  - name: "Board"
    view_type: "kanban"
    settings:
      kanbanField: "Status"

  - name: "Calendar"
    view_type: "calendar"
    settings:
      calendarDateField: "Due Date"
      calendarMode: "month"

  - name: "Timeline"
    view_type: "timeline"
    settings:
      timelineStartField: "Start Date"
      timelineEndField: "End Date"
      timelineGroupField: "Status"
      timelineZoom: "week"

  - name: "Overdue"
    view_type: "table"
    filters:
      id: root
      conjunction: and
      rules:
        - id: f1
          field: due_date
          operator: before
          value: today
        - id: f2
          field: status
          operator: is_not
          value: Done

active_view: "Active deals"
```

Each saved view can specify:

- `view_type`: `table` | `kanban` | `calendar` | `timeline` | `gallery` | `list` (defaults to object's `default_view`)
- `settings`: per-view-type configuration (overrides object-level `view_settings`)
- `filters`: standard filter rules
- `sort`: sort rules
- `columns`: optional visible column names for table view. Omit by default; if absent, the table shows the default/all columns. This controls visibility only, not order. Only set this when the user explicitly requests specific columns.
- `column_widths`: optional map of field name to pixel width. Set when the user explicitly asks for specific column sizes. The UI also auto-persists widths when columns are drag-resized.

When a user asks for date-based operations (e.g. move from one date to another) and no custom date fields exist, default to `created_at` unless the user explicitly asks for `updated_at`.

### Date Format

All date filter values MUST use ISO 8601 `YYYY-MM-DD` strings (e.g. `"2026-03-01"`). The special value `today` is also supported for `on`, `before`, and `after` operators.

### Date Range Filter (`date_between`)

```yaml
- id: f1
  field: Due Date
  operator: date_between
  value:
    - "2026-03-01"
    - "2026-03-31"
```

### Relative Date Filters (e.g. "in the last 7 days")

```yaml
- id: f1
  field: created_at
  operator: relative_past
  relativeAmount: 7
  relativeUnit: days
```

### OR Groups (match any rule)

```yaml
filters:
  id: root
  conjunction: or
  rules:
    - id: f1
      field: status
      operator: is
      value: "Active"
    - id: f2
      field: priority
      operator: is
      value: "High"
```

---

## Generating .object.yaml from DuckDB

**When the user asks to filter/show/hide entries by natural language**, treat that as a request to create or update a saved view unless they clearly want a one-off analysis only. Write the `.object.yaml` with the appropriate views and set `active_view`. Do not add `columns` unless the user explicitly asks for specific visible columns. If they ask to reorder columns, handle that separately by updating field `sort_order` and regenerating the top-level `fields` projection. The web UI will pick up the change instantly via SSE file watcher. Every rule needs a unique `id` (short alphanumeric string). The root filter group also needs `id: root`.

Generate by querying DuckDB then writing the file:

```bash
# 1. Query object + fields from DuckDB
duckdb {{WORKSPACE_PATH}}/workspace.duckdb -json "
  SELECT o.id, o.name, o.description, o.icon, o.default_view,
         (SELECT COUNT(*) FROM entries WHERE object_id = o.id) as entry_count
  FROM objects o WHERE o.name = 'lead'
"
duckdb {{WORKSPACE_PATH}}/workspace.duckdb -json "
  SELECT name, type, required, enum_values FROM fields
  WHERE object_id = (SELECT id FROM objects WHERE name = 'lead')
  ORDER BY sort_order
"

# 2. Write .object.yaml from the query results
mkdir -p {{WORKSPACE_PATH}}/lead
cat > {{WORKSPACE_PATH}}/lead/.object.yaml << 'YAML'
id: "AbCdEfGh..."
name: "lead"
description: "Sales leads tracking"
icon: "user-plus"
default_view: "table"
entry_count: 20
fields:
  - name: "Full Name"
    type: text
    required: true
  - name: "Email Address"
    type: email
    required: true
  - name: "Status"
    type: enum
    values: ["New", "Contacted", "Qualified", "Converted"]
  - name: "Score"
    type: number
  - name: "Notes"
    type: richtext
YAML
```
