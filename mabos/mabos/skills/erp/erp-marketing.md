# ERP Marketing Tools

## Tool: `erp_marketing`

Manage marketing campaigns, track metrics, and monitor KPIs. Plan, execute, and measure the effectiveness of marketing initiatives.

## Actions

### `create_campaign`

Create a new marketing campaign.

**Parameters:**

- `name` (required) - Campaign name
- `type` (required) - Campaign type (email, social, ppc, content, event)
- `budget` (optional) - Campaign budget
- `start_date` (optional) - Start date (ISO 8601)
- `end_date` (optional) - End date (ISO 8601)
- `target_audience` (optional) - Target audience description
- `channels` (optional) - Array of channels (e.g., ["email", "twitter", "linkedin"])

**Example:**

```json
{
  "action": "create_campaign",
  "params": {
    "name": "Spring Product Launch",
    "type": "email",
    "budget": 5000,
    "start_date": "2026-03-15",
    "end_date": "2026-04-15",
    "target_audience": "existing customers",
    "channels": ["email", "linkedin"]
  }
}
```

### `get_campaign`

Retrieve a campaign by ID.

**Parameters:**

- `id` (required) - Campaign ID

### `list_campaigns`

List campaigns with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (draft, active, paused, completed)
- `type` (optional) - Filter by campaign type
- `limit` (optional) - Max results

### `update_campaign`

Update campaign fields.

**Parameters:**

- `id` (required) - Campaign ID
- Additional fields to update (name, status, budget, end_date, channels)

### `record_metric`

Record a performance metric for a campaign.

**Parameters:**

- `campaign_id` (required) - Campaign ID
- `metric_type` (required) - Metric name (impressions, clicks, conversions, spend, revenue)
- `value` (required) - Metric value

**Example:**

```json
{
  "action": "record_metric",
  "params": { "campaign_id": "camp_007", "metric_type": "conversions", "value": 142 }
}
```

### `campaign_metrics`

Retrieve all recorded metrics for a campaign.

**Parameters:**

- `campaign_id` (required) - Campaign ID
- `limit` (optional) - Max results

### `create_kpi`

Define a key performance indicator.

**Parameters:**

- `name` (required) - KPI name
- `target` (required) - Target value
- `current` (optional) - Current value
- `unit` (optional) - Unit of measure (e.g., "%", "count", "USD")
- `period` (optional) - Tracking period (e.g., "2026-Q1")

**Example:**

```json
{
  "action": "create_kpi",
  "params": {
    "name": "Email Open Rate",
    "target": 25,
    "current": 18.5,
    "unit": "%",
    "period": "2026-Q1"
  }
}
```

### `list_kpis`

List KPIs with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (on_track, at_risk, behind)
- `period` (optional) - Filter by period
- `limit` (optional) - Max results

### `update_kpi`

Update KPI fields.

**Parameters:**

- `id` (required) - KPI ID
- Additional fields to update (current, target, status)

## Tips

- Record metrics regularly throughout a campaign, not just at the end.
- Use KPIs to set measurable goals and track progress across periods.
- Link campaign budgets to `erp_finance` for accurate marketing spend tracking.
- Compare campaign_metrics across campaigns of the same type to find top performers.
- Use `erp_analytics` to build dashboards that visualize campaign performance.
