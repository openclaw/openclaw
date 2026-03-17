# Query Execution

> **Prerequisite:** Read the [main skill](../../SKILL.md) for authentication, global flags, and key concepts.

Execute DuneSQL queries and retrieve results. This is the most commonly used part of the CLI.

Two ways to execute queries:

- **`query run <id>`** -- Execute a saved query by ID
- **`query run-sql --sql <SQL>`** -- Execute raw DuneSQL directly (no saved query needed)

Both support the same parameter, performance, and wait options.

---

## query run

Execute a saved query by ID and display results. By default, waits for completion (polls every 5 seconds, up to ~5 minutes).

```bash
dune query run <query-id> [flags]
```

### Arguments

| Argument   | Type      | Description                                  |
| ---------- | --------- | -------------------------------------------- |
| `query-id` | `integer` | The numeric ID of the saved query to execute |

### Flags

| Flag            | Type       | Required | Default  | Description                                                                     |
| --------------- | ---------- | -------- | -------- | ------------------------------------------------------------------------------- |
| `--param`       | `[]string` | No       | --       | Query parameter as `key=value` (repeatable). Values are auto-typed by the API.  |
| `--performance` | `string`   | No       | `medium` | Performance tier: `medium` (standard) or `large` (higher compute, more credits) |
| `--limit`       | `int`      | No       | `0`      | Maximum rows to display (`0` = all rows)                                        |
| `--no-wait`     | `bool`     | No       | `false`  | Submit and exit immediately without waiting for results                         |
| `-o, --output`  | `string`   | No       | `text`   | Output format: `text` or `json`                                                 |

### Wait Behavior

- **Default (wait mode):** Polls every 5 seconds for up to 60 retries (~5 minutes total). Displays results as a table when complete.
- **`--no-wait` mode:** Returns the execution ID and state immediately. Use `dune execution results <id>` to fetch results later.

### Output

**Wait mode, text:**

```
col_a   col_b   col_c
val1    val2    val3
val4    val5    val6

2 rows
```

**No-wait mode, text:**

```
Execution ID: 01JXYZ...
State:        QUERY_STATE_PENDING
```

**json:** Full API response object.

### Examples

```bash
# Run a saved query and wait for results
dune query run 12345 -o json

# Run with parameters
dune query run 12345 --param wallet=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --param days=30 -o json

# Run with large performance tier (for complex queries)
dune query run 12345 --performance large -o json

# Limit output to 50 rows
dune query run 12345 --limit 50 -o json

# Submit a long-running query without waiting
dune query run 12345 --no-wait --performance large -o json
```

---

## query run-sql

Execute raw DuneSQL directly without creating a saved query. Ideal for ad-hoc exploration and one-off analysis.

```bash
dune query run-sql --sql <SQL> [flags]
```

### Flags

| Flag            | Type       | Required | Default  | Description                                                                     |
| --------------- | ---------- | -------- | -------- | ------------------------------------------------------------------------------- |
| `--sql`         | `string`   | Yes      | --       | DuneSQL query to execute                                                        |
| `--param`       | `[]string` | No       | --       | Query parameter as `key=value` (repeatable). Values are auto-typed by the API.  |
| `--performance` | `string`   | No       | `medium` | Performance tier: `medium` (standard) or `large` (higher compute, more credits) |
| `--limit`       | `int`      | No       | `0`      | Maximum rows to display (`0` = all rows)                                        |
| `--no-wait`     | `bool`     | No       | `false`  | Submit and exit immediately without waiting for results                         |
| `-o, --output`  | `string`   | No       | `text`   | Output format: `text` or `json`                                                 |

### Output

Same format as `query run` (see above).

### Examples

```bash
# Simple ad-hoc query
dune query run-sql --sql "SELECT block_number, block_time FROM ethereum.blocks ORDER BY block_number DESC LIMIT 5" -o json

# Query with parameters
dune query run-sql --sql "SELECT * FROM ethereum.transactions WHERE block_number = {{block_num}} LIMIT 10" --param block_num=20000000 -o json

# Complex query with large tier
dune query run-sql \
  --sql "SELECT DATE_TRUNC('day', block_time) AS day, COUNT(*) AS tx_count FROM ethereum.transactions WHERE block_time > NOW() - INTERVAL '7' DAY GROUP BY 1 ORDER BY 1" \
  --performance large -o json

# Submit without waiting
dune query run-sql --sql "SELECT * FROM ethereum.transactions LIMIT 1000000" --no-wait -o json
```

### Performance: Always Filter on Partition Columns

Before running any query, ensure it includes a `WHERE` clause on the table's partition column (typically `block_time`, `block_date`, `evt_block_time`, or `call_block_time`). This is the single most impactful optimization:

```bash
# GOOD: partition filter included
dune query run-sql --sql "SELECT COUNT(*) FROM ethereum.transactions WHERE block_time >= NOW() - INTERVAL '7' DAY" -o json

# BAD: no partition filter -- scans entire table, slow and expensive
dune query run-sql --sql "SELECT COUNT(*) FROM ethereum.transactions" -o json
```

See [dunesql-cheatsheet.md](dunesql-cheatsheet.md#partition-columns--query-performance) for full details.

### When to Use `run-sql` vs `query run`

| Use Case                               | Command                                              |
| -------------------------------------- | ---------------------------------------------------- |
| Quick exploration, one-off analysis    | `run-sql`                                            |
| Reusable query you'll run repeatedly   | Create with `query create`, then `query run`         |
| Parameterized query shared with others | Create with `query create`, then `query run --param` |
| Testing SQL before saving              | `run-sql`                                            |

---

## execution results

Fetch the results of a previous query execution by its execution ID. Use this after submitting a query with `--no-wait`, or to re-fetch results from a completed execution.

```bash
dune execution results <execution-id> [flags]
```

### Arguments

| Argument       | Type     | Description                                                                       |
| -------------- | -------- | --------------------------------------------------------------------------------- |
| `execution-id` | `string` | The execution ID (returned by `query run --no-wait` or `query run-sql --no-wait`) |

### Flags

| Flag           | Type     | Required | Default | Description                             |
| -------------- | -------- | -------- | ------- | --------------------------------------- |
| `--limit`      | `int`    | No       | `0`     | Maximum rows to return (`0` = all rows) |
| `--offset`     | `int`    | No       | `0`     | Number of rows to skip (for pagination) |
| `-o, --output` | `string` | No       | `text`  | Output format: `text` or `json`         |

### Execution State Handling

The command behaves differently depending on the execution's current state:

| State               | Behavior                                               |
| ------------------- | ------------------------------------------------------ |
| Completed           | Displays result table with row count                   |
| Pending / Executing | Prints execution ID and current state (no results yet) |
| Failed              | Returns error with the failure message                 |
| Cancelled           | Returns error: `execution was cancelled`               |

### Output

**Completed, text:**

```
col_a   col_b
val1    val2
val3    val4

2 rows
```

**Pending, text:**

```
Execution ID: 01JXYZ...
State:        QUERY_STATE_EXECUTING
```

### Paginating Large Results

```bash
# First page: 100 rows
dune execution results 01JXYZ... --limit 100 --offset 0 -o json

# Second page: next 100 rows
dune execution results 01JXYZ... --limit 100 --offset 100 -o json

# Third page
dune execution results 01JXYZ... --limit 100 --offset 200 -o json
```

### Examples

```bash
# Fetch results of a completed execution
dune execution results 01JXYZ... -o json

# Fetch with row limit
dune execution results 01JXYZ... --limit 50 -o json

# Paginate through results
dune execution results 01JXYZ... --limit 100 --offset 200 -o json
```

---

## Error Handling

### Failed Executions

When a query execution fails, the error message typically includes details about what went wrong. Use the patterns below to diagnose and fix errors systematically.

### Error Recovery Patterns

| Error Pattern                                 | Likely Cause                                                          | Recovery                                                                                                                                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Column 'X' cannot be resolved`               | Misspelled column name or wrong table                                 | Run `dune dataset search --query "<table>" --include-schema -o json` to check actual column names                                                                                                       |
| `Table 'X' does not exist`                    | Wrong table name or namespace                                         | Run `dune dataset search --query "<keyword>" -o json` to find the correct fully-qualified name                                                                                                          |
| `Type mismatch` or `Cannot apply operator`    | Comparing incompatible types (e.g. string vs varbinary for addresses) | See [dunesql-cheatsheet.md](dunesql-cheatsheet.md#address-handling-critical) -- addresses must use `0x` prefix, not string quotes                                                                       |
| `Unexpected parameters` or `mismatched input` | SQL syntax error                                                      | Check for missing commas, unbalanced parentheses, or reserved words that need quoting (`"from"`, `"to"`)                                                                                                |
| `Query exceeded resource limits` or timeout   | Scanning too much data                                                | Add or tighten a partition filter (`WHERE block_time >= NOW() - INTERVAL '7' DAY`). See [dunesql-cheatsheet.md](dunesql-cheatsheet.md#partition-columns--query-performance). Try `--performance large`. |
| `Query killed` or `QUERY_STATE_CANCELLED`     | Execution cancelled (timeout, credit limit, or manual)                | Re-run with `--performance large` or reduce the query scope                                                                                                                                             |
| `Permission denied` or `Access denied`        | Private table or insufficient permissions                             | Verify the user owns the table or has access. Check `--owner-scope`                                                                                                                                     |
| `Division by zero`                            | Dividing by a zero-value column                                       | Wrap with `NULLIF()`: `amount / NULLIF(divisor, 0)`                                                                                                                                                     |
| `FROM_HEX` failure                            | Passing `0x`-prefixed string to `FROM_HEX()`                          | `FROM_HEX()` expects hex without `0x`. Use the `0x` literal syntax instead: `WHERE addr = 0xabc...`                                                                                                     |

### Step-by-Step Error Recovery

When a query fails:

1. **Read the full error message** from the JSON output (`error` field or `error.message`).
2. **Match the error** against the patterns above.
3. **For column/table errors**: Re-run `dune dataset search` with `--include-schema` to get the correct names.
4. **For type errors**: Check [dunesql-cheatsheet.md](dunesql-cheatsheet.md) for the correct type handling (especially addresses and token amounts).
5. **For performance errors**: Add a partition column filter, reduce the time range, or switch to `--performance large`.
6. **Fix the SQL** and re-execute. If the query was saved, use `dune query update <id> --sql "<fixed-sql>"` first.

### Polling Timeout

When using wait mode (default), if the query doesn't complete within ~5 minutes (60 polls at 5-second intervals), the CLI exits. The execution continues server-side. Use `dune execution results <id>` to check later.

---

## Complete Workflow: Submit, Poll, Paginate

```bash
# 1. Submit a heavy query without waiting
dune query run-sql \
  --sql "SELECT * FROM ethereum.transactions WHERE block_time > NOW() - INTERVAL '30' DAY" \
  --no-wait --performance large -o json
# Returns: {"execution_id": "01JXYZ...", "state": "QUERY_STATE_PENDING"}

# 2. Check status (repeat until completed)
dune execution results 01JXYZ... -o json
# Inspect the "state" field; if still pending/executing, re-run later

# 3. Fetch first page of results
dune execution results 01JXYZ... --limit 100 --offset 0 -o json

# 4. Fetch next page
dune execution results 01JXYZ... --limit 100 --offset 100 -o json
```

---

## See Also

- [query-management.md](query-management.md) -- Create and manage saved queries
- [dataset-discovery.md](dataset-discovery.md) -- Find table names and schemas before writing SQL
