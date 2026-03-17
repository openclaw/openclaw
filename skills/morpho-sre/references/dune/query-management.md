# Query Management

> **Prerequisite:** Read the [main skill](../SKILL.md) for authentication, global flags, and key concepts.

Manage saved Dune queries -- create, retrieve, update, and archive.

```bash
dune query <subcommand> [flags]
```

---

## query create

Create a new saved query.

```bash
dune query create --name <NAME> --sql <SQL> [flags]
```

### Flags

| Flag            | Type     | Required | Default | Description                                                         |
| --------------- | -------- | -------- | ------- | ------------------------------------------------------------------- |
| `--name`        | `string` | Yes      | --      | Human-readable query title                                          |
| `--sql`         | `string` | Yes      | --      | DuneSQL query text                                                  |
| `--description` | `string` | No       | `""`    | Short description of the query                                      |
| `--private`     | `bool`   | No       | `false` | Make the query private (not publicly visible)                       |
| `--temp`        | `bool`   | No       | `false` | Create a temporary query (auto-deleted, not shown in saved queries) |
| `-o, --output`  | `string` | No       | `text`  | Output format: `text` or `json`                                     |

### Output

- **text**: `Created query <id>`
- **json**: `{"query_id": <id>}`

### Examples

```bash
# Basic query
dune query create --name "Recent Blocks" --sql "SELECT block_number, block_time FROM ethereum.blocks ORDER BY block_number DESC LIMIT 10" -o json

# Private query with description
dune query create --name "Whale Tracker" \
  --sql "SELECT address, balance FROM ethereum.balances WHERE balance > 10000 ORDER BY balance DESC LIMIT 100" \
  --description "Track top ETH holders" \
  --private -o json

# Temporary query (for one-off analysis, not persisted to your saved queries)
dune query create --name "Quick Check" --sql "SELECT COUNT(*) FROM ethereum.transactions WHERE block_time > NOW() - INTERVAL '1' HOUR" --temp -o json

# Extract the query ID from JSON output
QUERY_ID=$(dune query create --name "My Query" --sql "SELECT 1" -o json | jq -r '.query_id')
```

### Tips

- Use `--temp` for throwaway queries to avoid cluttering your saved query list.
- Query IDs are integers. Save the returned ID to run the query later with `dune query run <id>`.
- All SQL must be valid DuneSQL syntax.

> [!CAUTION]
> This is a **write** command -- it creates a resource in the user's Dune account.

---

## query get

Fetch a saved query's SQL, metadata, and execution state.

```bash
dune query get <query-id>
```

### Arguments

| Argument   | Type      | Description                          |
| ---------- | --------- | ------------------------------------ |
| `query-id` | `integer` | The numeric ID of the query to fetch |

### Flags

| Flag           | Type     | Required | Default | Description                     |
| -------------- | -------- | -------- | ------- | ------------------------------- |
| `-o, --output` | `string` | No       | `text`  | Output format: `text` or `json` |

### Output

**text** format displays (Description and Tags only shown when non-empty):

```
ID:          12345
Name:        My Query
Description: A useful query
Owner:       alice
Engine:      v2 DuneSQL
Version:     3
Private:     false
Archived:    false
Tags:        defi, ethereum

SQL:
  SELECT block_number, block_time
  FROM ethereum.blocks
  ORDER BY block_number DESC
  LIMIT 10
```

**json** format returns the full `GetQueryResponse` object with all fields.

### Examples

```bash
# View a query's details
dune query get 12345 -o json

# Extract SQL text from JSON output
dune query get 12345 -o json | jq -r '.query_sql'
```

---

## query update

Update an existing saved query. At least one flag must be provided.

```bash
dune query update <query-id> [flags]
```

### Arguments

| Argument   | Type      | Description                           |
| ---------- | --------- | ------------------------------------- |
| `query-id` | `integer` | The numeric ID of the query to update |

### Flags

| Flag            | Type       | Required | Default | Description                        |
| --------------- | ---------- | -------- | ------- | ---------------------------------- |
| `--name`        | `string`   | No       | --      | New query name                     |
| `--sql`         | `string`   | No       | --      | New DuneSQL query text             |
| `--description` | `string`   | No       | --      | New description                    |
| `--private`     | `bool`     | No       | --      | Set privacy flag                   |
| `--tags`        | `[]string` | No       | --      | Replace all tags (comma-separated) |
| `-o, --output`  | `string`   | No       | `text`  | Output format: `text` or `json`    |

Only the provided flags are updated; omitted fields remain unchanged.

### Output

- **text**: `Updated query <id>`
- **json**: `{"query_id": <id>}`

### Examples

```bash
# Update SQL only
dune query update 12345 --sql "SELECT * FROM ethereum.blocks LIMIT 20" -o json

# Update name and add tags
dune query update 12345 --name "Updated Query" --tags defi,ethereum,uniswap -o json

# Make a query private
dune query update 12345 --private -o json
```

> [!CAUTION]
> This is a **write** command -- it modifies an existing resource.

---

## query archive

Archive a saved query. Archived queries are hidden from the default query list but not deleted.

```bash
dune query archive <query-id>
```

### Arguments

| Argument   | Type      | Description                            |
| ---------- | --------- | -------------------------------------- |
| `query-id` | `integer` | The numeric ID of the query to archive |

### Flags

| Flag           | Type     | Required | Default | Description                     |
| -------------- | -------- | -------- | ------- | ------------------------------- |
| `-o, --output` | `string` | No       | `text`  | Output format: `text` or `json` |

### Output

- **text**: `Archived query <id>`
- **json**: `{"query_id": <id>}`

### Examples

```bash
dune query archive 12345 -o json
```

> [!CAUTION]
> This is a **destructive** command -- it archives the query. To unarchive, use the Dune web UI or API.

---

## See Also

- [query-execution.md](query-execution.md) -- Run queries and fetch execution results
- [dataset-discovery.md](dataset-discovery.md) -- Search for tables before writing SQL
