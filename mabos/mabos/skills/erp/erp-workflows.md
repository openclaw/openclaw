# ERP Workflows Tools

## Tool: `erp_workflows`

Automate business processes with trigger-based workflows. Define multi-step workflows, execute runs, and track step-by-step progress.

## Actions

### `create_workflow`

Define a new automation workflow.

**Parameters:**

- `name` (required) - Workflow name
- `trigger` (required) - What initiates the workflow (manual, schedule, event)
- `steps` (required) - Array of {order, action, config} step definitions
- `description` (optional) - Workflow description

**Example:**

```json
{
  "action": "create_workflow",
  "params": {
    "name": "New Order Processing",
    "trigger": "event:order_created",
    "description": "Validates inventory, creates shipment, and notifies customer",
    "steps": [
      { "order": 1, "action": "check_inventory", "config": { "source": "erp_inventory" } },
      { "order": 2, "action": "create_shipment", "config": { "source": "erp_supply_chain" } },
      { "order": 3, "action": "notify_customer", "config": { "channel": "email" } }
    ]
  }
}
```

### `get_workflow`

Retrieve a workflow by ID.

**Parameters:**

- `id` (required) - Workflow ID

### `list_workflows`

List workflows with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (active, paused, archived)
- `trigger` (optional) - Filter by trigger type
- `limit` (optional) - Max results

### `update_workflow`

Update workflow fields.

**Parameters:**

- `id` (required) - Workflow ID
- Additional fields to update (name, status, steps, trigger, description)

### `start_run`

Initiate a new workflow run.

**Parameters:**

- `workflow_id` (required) - Workflow to execute
- `context` (optional) - Runtime context data passed to steps

**Example:**

```json
{
  "action": "start_run",
  "params": {
    "workflow_id": "wf_003",
    "context": { "order_id": "ord_055", "customer_id": "cust_001" }
  }
}
```

### `get_run`

Retrieve a workflow run by ID.

**Parameters:**

- `id` (required) - Run ID

### `list_runs`

List workflow runs with optional filters.

**Parameters:**

- `workflow_id` (optional) - Filter by workflow
- `status` (optional) - Filter by status (running, paused, completed, failed)
- `limit` (optional) - Max results

### `advance_step`

Move a running workflow to the next step.

**Parameters:**

- `run_id` (required) - Run ID to advance

### `fail_run`

Mark a workflow run as failed with an error.

**Parameters:**

- `run_id` (required) - Run ID
- `error` (required) - Error message describing the failure

**Example:**

```json
{
  "action": "fail_run",
  "params": { "run_id": "run_042", "error": "Inventory check failed: item out of stock" }
}
```

### `complete_run`

Mark a workflow run as successfully completed.

**Parameters:**

- `run_id` (required) - Run ID

## Tips

- Design workflows with idempotent steps so failed runs can be safely retried.
- Pass context data in `start_run` to make workflows reusable across different triggers.
- Use `list_runs` with status=failed to monitor and triage broken automations.
- Keep steps granular — one action per step makes debugging easier.
- Combine workflows with other ERP tools for end-to-end process automation.
