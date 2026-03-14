# Supabase Workflow Integration

This directory contains example workflows demonstrating the Supabase integration for OpenClaw's workflow system.

## Overview

The Supabase integration provides five workflow node types for database operations:

- **🔍 Supabase Select** - Query data from tables
- **➕ Supabase Insert** - Insert new records
- **✏️ Supabase Update** - Update existing records
- **🗑️ Supabase Delete** - Delete records
- **⚡ Supabase RPC** - Call database functions

## Configuration

### 1. Add Supabase Config

Add your Supabase configuration to your OpenClaw config file:

```json
{
  "supabase": {
    "instances": {
      "default": {
        "url": "https://your-project.supabase.co",
        "key": "your-service-role-key",
        "schema": "public"
      }
    },
    "defaultInstance": "default"
  }
}
```

### 2. Security Best Practices

- **Use environment variables** for Supabase keys
- **Use service role key** for backend operations (not anon key)
- **Validate all inputs** before querying
- **Sanitize filters** to prevent injection
- **Log all database operations** for audit trails

### 3. Environment Variables

```bash
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## Example Workflows

### User Onboarding (`user-onboarding.json`)

Automated workflow for new user onboarding:
1. Validates user input with AI
2. Creates user record in database
3. Sets up default preferences
4. Logs the onboarding event
5. Sends personalized welcome message

### Data Sync (`data-sync.json`)

Batch data synchronization workflow:
1. Fetches pending sync records
2. Processes each record with AI analysis
3. Updates sync queue status
4. Logs sync operations

### Cleanup (`cleanup.json`)

Automated database maintenance:
1. Deletes expired sessions
2. Removes old audit logs (90+ days)
3. Archives important old data
4. Logs cleanup operations

### Report Generation (`report-generation.json`)

Weekly analytics report generation:
1. Fetches user statistics
2. Fetches activity logs
3. Analyzes data with AI
4. Stores generated report
5. Updates dashboard cache
6. Generates notification summary

## Node Configuration

### Supabase Select

```json
{
  "actionType": "supabase-select",
  "instance": "default",
  "table": "users",
  "columns": "id,name,email",
  "filters": {
    "status": { "eq": "active" },
    "created_at": { "gte": "2024-01-01" }
  },
  "orderBy": {
    "column": "created_at",
    "ascending": false
  },
  "limit": 100,
  "offset": 0
}
```

### Supabase Insert

```json
{
  "actionType": "supabase-insert",
  "instance": "default",
  "table": "users",
  "data": {
    "name": "John Doe",
    "email": "john@example.com"
  },
  "returning": "representation",
  "upsert": false
}
```

### Supabase Update

```json
{
  "actionType": "supabase-update",
  "instance": "default",
  "table": "users",
  "data": {
    "status": "active",
    "updated_at": "2024-01-15T10:30:00Z"
  },
  "filters": {
    "id": { "eq": 123 }
  },
  "returning": "representation"
}
```

### Supabase Delete

```json
{
  "actionType": "supabase-delete",
  "instance": "default",
  "table": "sessions",
  "filters": {
    "expires_at": { "lt": "now()" }
  },
  "returning": "minimal"
}
```

### Supabase RPC

```json
{
  "actionType": "supabase-rpc",
  "instance": "default",
  "functionName": "get_user_stats",
  "args": {
    "user_id": 123,
    "start_date": "2024-01-01"
  }
}
```

## Filter Operators

Supported filter operators for WHERE clauses:

- `eq` - Equal
- `neq` - Not equal
- `gt` - Greater than
- `gte` - Greater than or equal
- `lt` - Less than
- `lte` - Less than or equal
- `like` - Pattern matching (case-sensitive)
- `ilike` - Pattern matching (case-insensitive)
- `in` - IN clause (array of values)
- `is` - IS NULL/TRUE/FALSE
- `contains` - Array/JSON contains
- `containedBy` - Array/JSON contained by

## Output Schema

All Supabase operations return a consistent result structure:

```typescript
interface SupabaseResult {
  success: boolean;
  data?: T | T[] | null;
  error?: string | null;
  errorDetails?: PostgrestError | null;
  count?: number | null;
  timestamp: number;
}
```

## Testing

### 1. Install Dependencies

```bash
pnpm add -w @supabase/supabase-js
```

### 2. Build

```bash
pnpm build
```

### 3. Test with Real Supabase

```bash
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_KEY=your-key-here

# Create a test workflow in the UI
# Execute and verify results
```

### 4. Verify Results

Check the workflow execution logs and verify:
- Database operations completed successfully
- Data was inserted/updated/deleted as expected
- Error handling works correctly
- Logs are being recorded

## Troubleshooting

### Common Issues

1. **"Supabase configuration not found"**
   - Ensure `supabase` config is added to OpenClaw config
   - Check that `defaultInstance` is set or instance name matches

2. **"Invalid table name"**
   - Table names must be alphanumeric with underscores only
   - Cannot contain SQL injection characters

3. **"Filters are required"**
   - UPDATE and DELETE operations require filters to prevent accidental bulk operations
   - Use specific conditions to target rows

4. **"Connection timeout"**
   - Check Supabase URL is correct
   - Verify network connectivity
   - Ensure service role key is valid

## Advanced Usage

### Chaining Operations

You can chain multiple Supabase operations in a single workflow:

```json
{
  "steps": [
    {
      "id": "step-1",
      "actionType": "supabase-select",
      "table": "users",
      "filters": { "status": { "eq": "pending" } }
    },
    {
      "id": "step-2",
      "actionType": "supabase-update",
      "table": "users",
      "data": { "status": "active" },
      "filters": { "id": { "in": "{{step-1.data[*].id}}" } }
    }
  ]
}
```

### Using AI with Supabase

Combine AI analysis with database operations:

```json
{
  "steps": [
    {
      "id": "fetch-data",
      "actionType": "supabase-select",
      "table": "feedback"
    },
    {
      "id": "analyze",
      "actionType": "ai-agent-prompt",
      "prompt": "Analyze this feedback and categorize: {{fetch-data.data}}"
    },
    {
      "id": "store-results",
      "actionType": "supabase-insert",
      "table": "feedback_analysis",
      "data": "{{analyze.output}}"
    }
  ]
}
```

## Resources

- [Supabase Documentation](https://supabase.com/docs)
- [PostgREST API](https://postgrest.org/en/stable/)
- [OpenClaw Workflow System](../../../docs/workflows.md)
