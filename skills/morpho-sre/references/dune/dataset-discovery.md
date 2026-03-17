# Dataset Discovery

> **Prerequisite:** Read the [main skill](../SKILL.md) for authentication, global flags, and key concepts.

Search the Dune dataset catalog to discover tables and their schemas before writing SQL.

Two search modes:

- **`dataset search`** -- Keyword and filter-based search across all datasets
- **`dataset search-by-contract`** -- Find decoded tables for a specific contract address

---

## Understanding Dune Datasets

### Categories

| Category    | Description                                                   | Examples                                                                       |
| ----------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `canonical` | Core blockchain data maintained by Dune                       | `ethereum.blocks`, `ethereum.transactions`, `ethereum.traces`, `ethereum.logs` |
| `decoded`   | ABI-decoded contract data (events and function calls)         | `uniswap_v3_ethereum.evt_Swap`, `erc20_ethereum.evt_Transfer`                  |
| `spell`     | Curated Spellbook transformations (higher-level, cross-chain) | `dex.trades`, `tokens.transfers`, `nft.trades`                                 |
| `community` | Community-contributed datasets                                | Varies                                                                         |

### Decoded Tables

Decoded tables parse raw blockchain data using a contract's ABI into structured columns. Two types:

- **Event tables** (`evt_`): Contain parsed event logs. Named `<project>_<chain>.evt_<EventName>`.
  Example: `uniswap_v3_ethereum.evt_Swap`
- **Call tables** (`call_`): Contain parsed function calls. Named `<project>_<chain>.call_<FunctionName>`.
  Example: `uniswap_v3_ethereum.call_swap`

### Dataset Types

| Type                   | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| `dune_table`           | Core Dune-maintained tables (canonical chain data)      |
| `decoded_table`        | Contract ABI-decoded event and call tables              |
| `spell`                | Spellbook transformation tables (curated, higher-level) |
| `uploaded_table`       | User-uploaded CSV or data tables                        |
| `transformation_table` | Materialized user-created transformation tables         |
| `transformation_view`  | Virtual user-created transformation views               |

---

## dataset search

Search for datasets across the Dune catalog by keyword, category, blockchain, and other filters.

```bash
dune dataset search [flags]
```

### Flags

| Flag                 | Type       | Required | Default | Description                                                                                                             |
| -------------------- | ---------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--query`            | `string`   | No       | `""`    | Search query text (natural language or table name keywords)                                                             |
| `--categories`       | `[]string` | No       | --      | Filter by category: `canonical`, `decoded`, `spell`, `community`                                                        |
| `--blockchains`      | `[]string` | No       | --      | Filter by blockchain (e.g. `ethereum`, `arbitrum`, `solana`)                                                            |
| `--dataset-types`    | `[]string` | No       | --      | Filter by type: `dune_table`, `decoded_table`, `spell`, `uploaded_table`, `transformation_table`, `transformation_view` |
| `--schemas`          | `[]string` | No       | --      | Filter by schema/namespace (e.g. `dex`, `uniswap_v3_ethereum`)                                                          |
| `--owner-scope`      | `string`   | No       | `""`    | Ownership filter: `all`, `me`, `team`                                                                                   |
| `--include-private`  | `bool`     | No       | `false` | Include private datasets in results                                                                                     |
| `--include-schema`   | `bool`     | No       | `false` | Include column-level schema (name, type, nullable) for each table                                                       |
| `--include-metadata` | `bool`     | No       | `false` | Include metadata (description, page rank, ABI type, project name, etc.)                                                 |
| `--limit`            | `int32`    | No       | `20`    | Maximum number of results                                                                                               |
| `--offset`           | `int32`    | No       | `0`     | Pagination offset                                                                                                       |
| `-o, --output`       | `string`   | No       | `text`  | Output format: `text` or `json`                                                                                         |

### Output

**text:**

```
FULL_NAME                           CATEGORY   DATASET_TYPE    BLOCKCHAINS
uniswap_v3_ethereum.evt_Swap        decoded    decoded_table   ethereum
uniswap_v3_arbitrum.evt_Swap        decoded    decoded_table   arbitrum

2 of 15 results
```

**json:** Full response object with all result fields.

### Examples

```bash
# Search by keyword
dune dataset search --query "uniswap swaps" -o json

# Search decoded tables only
dune dataset search --query "transfer" --categories decoded -o json

# Search Spellbook tables for DEX trades
dune dataset search --query "trades" --categories spell --schemas dex -o json

# Search across specific blockchains
dune dataset search --query "nft" --blockchains ethereum --blockchains polygon -o json

# Include column schemas (useful before writing SQL)
dune dataset search --query "uniswap v3" --categories decoded --include-schema -o json

# Browse your own datasets
dune dataset search --owner-scope me -o json

# Paginate through results
dune dataset search --query "erc20" --limit 50 --offset 0 -o json
dune dataset search --query "erc20" --limit 50 --offset 50 -o json
```

### Tips

- Use `--include-schema` when you need column names and types to write SQL.
- Use `--include-metadata` to get table descriptions, which helps understand what data each table contains.
- Start broad with just `--query`, then narrow with `--categories` and `--blockchains`.
- Use `--schemas` to search within a specific project namespace (e.g. `--schemas uniswap_v3_ethereum`).

### Identifying Partition Columns

When reviewing schema output, look for **partition columns** -- these are the columns the table is physically partitioned by (typically time-based). Filtering on partition columns is critical for query performance and credit cost.

Common partition column names by table type:

| Table Type                                       | Partition Column           |
| ------------------------------------------------ | -------------------------- |
| Canonical tables (`ethereum.transactions`, etc.) | `block_time`, `block_date` |
| Decoded event tables (`evt_*`)                   | `evt_block_time`           |
| Decoded call tables (`call_*`)                   | `call_block_time`          |
| Spellbook tables (`dex.trades`, etc.)            | `block_time`, `block_date` |

**Always include `--include-schema`** when the goal is to write a query. After discovering a table, check for its partition columns and instruct the user (or include in generated SQL) a `WHERE` clause on the partition column.

See [dunesql-cheatsheet.md](dunesql-cheatsheet.md#partition-columns--query-performance) for partition filter patterns and examples.

---

## dataset search-by-contract

Search for decoded tables (events and calls) associated with a specific smart contract address. Use this when you have a contract address and want to know what on-chain data is available for it.

```bash
dune dataset search-by-contract --contract-address <ADDRESS> [flags]
```

### Flags

| Flag                 | Type       | Required | Default | Description                                                                     |
| -------------------- | ---------- | -------- | ------- | ------------------------------------------------------------------------------- |
| `--contract-address` | `string`   | Yes      | --      | Contract address (EVM `0x...` or Tron format)                                   |
| `--blockchains`      | `[]string` | No       | --      | Filter to specific blockchains. Can be specified multiple times.                |
| `--include-schema`   | `bool`     | No       | `false` | Include column-level schema (name, type, nullable). Enable when preparing SQL.  |
| `--limit`            | `int32`    | No       | `20`    | Maximum results. Use 5-10 for quick checks, 50-100 for comprehensive discovery. |
| `--offset`           | `int32`    | No       | `0`     | Pagination offset                                                               |
| `-o, --output`       | `string`   | No       | `text`  | Output format: `text` or `json`                                                 |

### Output

Same format as `dataset search` (table with FULL_NAME, CATEGORY, DATASET_TYPE, BLOCKCHAINS columns).

### Examples

```bash
# Find all decoded tables for a contract (e.g., Uniswap UNI token)
dune dataset search-by-contract --contract-address 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984 -o json

# Filter to a specific blockchain
dune dataset search-by-contract --contract-address 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984 --blockchains ethereum -o json

# Multi-chain contract (same address deployed on multiple chains)
dune dataset search-by-contract --contract-address 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984 --blockchains ethereum --blockchains arbitrum -o json

# Include column schemas for SQL generation
dune dataset search-by-contract --contract-address 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984 --include-schema -o json

# Comprehensive discovery with higher limit
dune dataset search-by-contract --contract-address 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984 --limit 100 -o json
```

### When to Use Which

| Scenario                                     | Command                                 |
| -------------------------------------------- | --------------------------------------- |
| You have a contract address                  | `search-by-contract`                    |
| You know a project name (e.g., "uniswap")    | `dataset search --query "uniswap"`      |
| You need canonical chain data (blocks, txs)  | `dataset search --categories canonical` |
| You need Spellbook tables (dex.trades, etc.) | `dataset search --categories spell`     |
| You want to browse all tables for a chain    | `dataset search --blockchains ethereum` |

---

## Workflow: Discover Tables and Write SQL

```bash
# Step 1: Search for relevant tables (always include schema)
dune dataset search --query "uniswap v3 swaps" --categories decoded --include-schema -o json

# Step 2: Review the column schema from the JSON output
# - Look at the "schema" field for column names and types
# - Identify the partition column (evt_block_time for decoded event tables)

# Step 3: Write and execute SQL using discovered table and column names
# IMPORTANT: Always filter on the partition column (evt_block_time here)
dune query run-sql --sql "
  SELECT
    evt_block_time,
    token0,
    token1,
    amount0,
    amount1
  FROM uniswap_v3_ethereum.evt_Swap
  WHERE evt_block_time > NOW() - INTERVAL '1' DAY
  ORDER BY evt_block_time DESC
  LIMIT 100
" -o json
```

---

## See Also

- [query-execution.md](query-execution.md) -- Execute queries against discovered tables
- [query-management.md](query-management.md) -- Save queries for repeated use
