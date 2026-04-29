---
name: sentry-cli-dashboard
version: 0.27.0
description: Manage Sentry dashboards
requires:
  bins: ["sentry"]
  auth: true
---

# Dashboard Commands

Manage Sentry dashboards

### `sentry dashboard list <org/title-filter...>`

List dashboards

**Flags:**
- `-w, --web - Open in browser`
- `-n, --limit <value> - Maximum number of dashboards to list - (default: "25")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**Examples:**

```bash
# List all dashboards
sentry dashboard list

# Filter by name pattern
sentry dashboard list "Backend*"

# Open dashboard list in browser
sentry dashboard list -w
```

### `sentry dashboard view <org/project/dashboard...>`

View a dashboard

**Flags:**
- `-w, --web - Open in browser`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-r, --refresh <value> - Auto-refresh interval in seconds (default: 60, min: 10)`
- `-t, --period <value> - Time range: "7d", "2026-03-01..2026-04-01", ">=2026-03-01"`

**Examples:**

```bash
# View by title
sentry dashboard view 'Frontend Performance'

# View by ID
sentry dashboard view 12345

# Auto-refresh every 30 seconds
sentry dashboard view "Backend Performance" --refresh 30

# Open in browser
sentry dashboard view 12345 -w
```

### `sentry dashboard create <org/project/title...>`

Create a dashboard

**Examples:**

```bash
sentry dashboard create 'Frontend Performance'
```

### `sentry dashboard widget add <org/project/dashboard/title...>`

Add a widget to a dashboard

**Flags:**
- `-d, --display <value> - Display type (big_number, line, area, bar, table, stacked_area, top_n, text, categorical_bar, details, wheel, rage_and_dead_clicks, server_tree, agents_traces_table)`
- `--dataset <value> - Widget dataset (default: spans)`
- `-q, --query <value>... - Aggregate expression (e.g. count, p95:span.duration)`
- `-w, --where <value> - Search conditions filter (e.g. is:unresolved)`
- `-g, --group-by <value>... - Group-by column (repeatable)`
- `-s, --sort <value> - Order by (prefix - for desc, e.g. -count)`
- `-n, --limit <value> - Result limit`
- `-x, --col <value> - Grid column position (0-based, 0–5)`
- `-y, --row <value> - Grid row position (0-based)`
- `--width <value> - Widget width in grid columns (1–6)`
- `--height <value> - Widget height in grid rows (min 1)`
- `-l, --layout <value> - Layout mode: sequential (append in order) or dense (fill gaps) - (default: "sequential")`

**Examples:**

```bash
# Simple counter widget
sentry dashboard widget add 'My Dashboard' "Error Count" \
  --display big_number --query count

# Line chart with group-by
sentry dashboard widget add 'My Dashboard' "Errors by Browser" \
  --display line --query count --group-by browser.name

# Table with multiple aggregates, sorted descending
sentry dashboard widget add 'My Dashboard' "Top Endpoints" \
  --display table \
  --query count --query p95:span.duration \
  --group-by transaction \
  --sort -count --limit 10

# With search filter
sentry dashboard widget add 'My Dashboard' "Slow Requests" \
  --display bar --query p95:span.duration \
  --where "span.op:http.client" \
  --group-by span.description
```

### `sentry dashboard widget edit <org/project/dashboard...>`

Edit a widget in a dashboard

**Flags:**
- `-i, --index <value> - Widget index (0-based)`
- `-t, --title <value> - Widget title to match`
- `--new-title <value> - New widget title`
- `-d, --display <value> - Display type (big_number, line, area, bar, table, stacked_area, top_n, text, categorical_bar, details, wheel, rage_and_dead_clicks, server_tree, agents_traces_table)`
- `--dataset <value> - Widget dataset (default: spans)`
- `-q, --query <value>... - Aggregate expression (e.g. count, p95:span.duration)`
- `-w, --where <value> - Search conditions filter (e.g. is:unresolved)`
- `-g, --group-by <value>... - Group-by column (repeatable)`
- `-s, --sort <value> - Order by (prefix - for desc, e.g. -count)`
- `-n, --limit <value> - Result limit`
- `-x, --col <value> - Grid column position (0-based, 0–5)`
- `-y, --row <value> - Grid row position (0-based)`
- `--width <value> - Widget width in grid columns (1–6)`
- `--height <value> - Widget height in grid rows (min 1)`

**Examples:**

```bash
# Change display type
sentry dashboard widget edit 12345 --title 'Error Count' --display bar

# Rename a widget
sentry dashboard widget edit 'My Dashboard' --index 0 --new-title 'Total Errors'

# Change the query
sentry dashboard widget edit 12345 --title 'Error Rate' --query p95:span.duration
```

### `sentry dashboard widget delete <org/project/dashboard...>`

Delete a widget from a dashboard

**Flags:**
- `-i, --index <value> - Widget index (0-based)`
- `-t, --title <value> - Widget title to match`
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`
- `-n, --dry-run - Show what would happen without making changes`

**Examples:**

```bash
# Delete by title
sentry dashboard widget delete 'My Dashboard' --title 'Error Count'

# Delete by index
sentry dashboard widget delete 12345 --index 2
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
