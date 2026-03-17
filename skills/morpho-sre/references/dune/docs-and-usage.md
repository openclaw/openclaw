# Documentation Search & Account Usage

> **Prerequisite:** Read the [main skill](../SKILL.md) for authentication, global flags, and key concepts.

---

## docs search

Search the official Dune documentation. **No authentication required.**

Use this to look up DuneSQL syntax, API reference, table naming conventions, query engine behavior, and Dune platform concepts.

```bash
dune docs search --query <TEXT> [flags]
```

### Flags

| Flag                   | Type     | Required | Default | Description                                                 |
| ---------------------- | -------- | -------- | ------- | ----------------------------------------------------------- |
| `--query`              | `string` | Yes      | --      | Search query text (natural language)                        |
| `--api-reference-only` | `bool`   | No       | `false` | Prioritize API reference pages over conceptual guides       |
| `--code-only`          | `bool`   | No       | `false` | Prioritize pages with executable code examples and snippets |
| `-o, --output`         | `string` | No       | `text`  | Output format: `text` or `json`                             |

### Output

**text:**

```
  DuneSQL Functions and Operators
  https://docs.dune.com/query-engine/Functions-and-operators
  Complete reference of all functions and operators available in DuneSQL...

  Writing Efficient Queries
  https://docs.dune.com/query-engine/writing-efficient-queries
  Guidelines for optimizing query performance...

2 result(s)
```

**json:**

```json
{ "query": "<query>", "results": [{ "title": "...", "url": "...", "description": "..." }] }
```

### Examples

```bash
# Look up DuneSQL functions
dune docs search --query "DuneSQL string functions" -o json

# Find API reference for query execution
dune docs search --query "execute query API" --api-reference-only -o json

# Find code examples for working with decoded tables
dune docs search --query "decoded tables query examples" --code-only -o json

# Search for information about Spellbook
dune docs search --query "what is Spellbook" -o json

# Look up specific DuneSQL syntax
dune docs search --query "INTERVAL syntax DuneSQL" -o json
```

### Useful Search Topics

| Topic                        | Example Query                                              |
| ---------------------------- | ---------------------------------------------------------- |
| DuneSQL syntax and functions | `"DuneSQL functions"`, `"INTERVAL syntax"`, `"CAST types"` |
| Table naming and structure   | `"decoded tables"`, `"canonical tables"`, `"table naming"` |
| Query optimization           | `"writing efficient queries"`, `"query performance"`       |
| API endpoints and limits     | `"API rate limits"`, `"execute query API"`                 |
| Blockchain-specific data     | `"ethereum transactions schema"`, `"solana data"`          |
| Spellbook                    | `"Spellbook tables"`, `"dex.trades"`                       |

---

## usage

Show credit and resource usage for your Dune account.

```bash
dune usage [flags]
```

### Flags

| Flag           | Type     | Required | Default | Description                             |
| -------------- | -------- | -------- | ------- | --------------------------------------- |
| `--start-date` | `string` | No       | --      | Filter start date (`YYYY-MM-DD` format) |
| `--end-date`   | `string` | No       | --      | Filter end date (`YYYY-MM-DD` format)   |
| `-o, --output` | `string` | No       | `text`  | Output format: `text` or `json`         |

### Output

**text** (billing period table shown only when billing data is available):

```
Private Queries:      15
Private Dashboards:   3
Storage Used:         1.2 GB / 10 GB

START DATE  END DATE    CREDITS USED  CREDITS INCLUDED
2025-01-01  2025-02-01  123.45        1000
2025-02-01  2025-03-01  456.78        1000
```

**json:** Full `UsageResponse` object including all billing periods.

### Examples

```bash
# Show current usage summary
dune usage -o json

# Filter to a specific date range
dune usage --start-date 2025-01-01 --end-date 2025-06-01 -o json
```

### What's Included

| Field                  | Description                                      |
| ---------------------- | ------------------------------------------------ |
| Private Queries        | Number of private queries in your account        |
| Private Dashboards     | Number of private dashboards                     |
| Storage Used / Allowed | Data storage consumed vs. plan allowance         |
| Credits Used           | Credits consumed per billing period              |
| Credits Included       | Credits included in your plan per billing period |

---

## See Also

- [Main skill](../SKILL.md) -- Authentication, global flags, and command overview
