# ERP HR Tools

## Tool: `erp_hr`

Manage employees, payroll processing, and department organization. Handles onboarding, role assignments, and compensation calculations.

## Actions

### `onboard_employee`

Create and onboard a new employee.

**Parameters:**

- `name` (required) - Employee full name
- `email` (optional) - Work email address
- `role` (optional) - Job title or role
- `department` (optional) - Department name
- `start_date` (optional) - Employment start date (ISO 8601)

**Example:**

```json
{
  "action": "onboard_employee",
  "params": {
    "name": "Alex Rivera",
    "email": "alex@company.com",
    "role": "Backend Engineer",
    "department": "Engineering",
    "start_date": "2026-03-01"
  }
}
```

### `get`

Retrieve an employee by ID.

**Parameters:**

- `id` (required) - Employee ID

### `list`

List employees with optional filters.

**Parameters:**

- `department` (optional) - Filter by department
- `status` (optional) - Filter by status (active, onboarding, terminated)
- `limit` (optional) - Max results

### `update`

Update employee fields.

**Parameters:**

- `id` (required) - Employee ID
- Additional fields to update (name, email, role, department, status)

### `delete`

Remove an employee record.

**Parameters:**

- `id` (required) - Employee ID

### `run_payroll`

Process payroll for an employee for a given period.

**Parameters:**

- `employee_id` (required) - Employee ID
- `period` (required) - Pay period (e.g., "2026-02")
- `gross` (required) - Gross pay amount
- `deductions` (required) - Deductions object {tax, benefits, other}

**Example:**

```json
{
  "action": "run_payroll",
  "params": {
    "employee_id": "emp_012",
    "period": "2026-02",
    "gross": 8000,
    "deductions": { "tax": 1800, "benefits": 400, "other": 100 }
  }
}
```

## Tips

- Always use `onboard_employee` for new hires rather than raw create — it sets up defaults.
- Run payroll per period consistently; missed periods cause reconciliation headaches.
- Use department filters in `list` to generate team rosters quickly.
- Update employee status to "terminated" instead of deleting to preserve records.
