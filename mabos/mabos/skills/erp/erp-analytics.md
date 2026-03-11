# ERP Analytics Tools

## Tool: `erp_analytics`

Create and run reports, manage dashboards, and capture report snapshots. Provides cross-domain data analysis and visualization capabilities.

## Actions

### `create_report`

Define a new report.

**Parameters:**

- `name` (required) - Report name
- `type` (required) - Report type (financial, sales, inventory, hr, custom)
- `query` (required) - Query definition or data source specification
- `parameters` (optional) - Report parameters object
- `schedule` (optional) - Cron-style schedule for automated runs

**Example:**

```json
{
  "action": "create_report",
  "params": {
    "name": "Monthly Revenue Summary",
    "type": "financial",
    "query": "revenue_by_month",
    "parameters": { "year": 2026 },
    "schedule": "0 0 1 * *"
  }
}
```

### `get_report`

Retrieve a report definition by ID.

**Parameters:**

- `id` (required) - Report ID

### `list_reports`

List reports with optional filters.

**Parameters:**

- `type` (optional) - Filter by report type
- `status` (optional) - Filter by status (active, archived)
- `limit` (optional) - Max results

### `run_report`

Execute a report and generate results.

**Parameters:**

- `report_id` (required) - Report ID to run

**Example:**

```json
{ "action": "run_report", "params": { "report_id": "rpt_010" } }
```

### `delete_report`

Remove a report definition.

**Parameters:**

- `id` (required) - Report ID

### `create_dashboard`

Create a new dashboard with widget layout.

**Parameters:**

- `name` (required) - Dashboard name
- `description` (optional) - Dashboard purpose
- `widgets` (optional) - Array of widget configurations
- `owner_id` (optional) - Dashboard owner

**Example:**

```json
{
  "action": "create_dashboard",
  "params": {
    "name": "Executive Overview",
    "description": "High-level KPIs and financial metrics",
    "widgets": [
      { "type": "chart", "report_id": "rpt_010" },
      { "type": "kpi_grid", "source": "marketing_kpis" }
    ],
    "owner_id": "emp_001"
  }
}
```

### `get_dashboard`

Retrieve a dashboard by ID.

**Parameters:**

- `id` (required) - Dashboard ID

### `list_dashboards`

List dashboards with optional filters.

**Parameters:**

- `owner_id` (optional) - Filter by owner
- `limit` (optional) - Max results

### `report_snapshots`

Retrieve historical snapshots from previous report runs.

**Parameters:**

- `report_id` (required) - Report ID
- `limit` (optional) - Max snapshots to return

## Tips

- Use scheduled reports to automate recurring analysis (daily sales, weekly inventory).
- Build dashboards that pull from multiple report types for cross-domain visibility.
- Review report_snapshots to identify trends over time.
- Keep report queries focused — one metric per report is easier to compose into dashboards.
- Pair with `erp_marketing` KPIs and `erp_finance` P&L for executive-level dashboards.
