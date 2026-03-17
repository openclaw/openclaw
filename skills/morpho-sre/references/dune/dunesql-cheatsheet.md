# DuneSQL Cheatsheet

> **Prerequisite:** Read the [main skill](../SKILL.md) for authentication, global flags, and key concepts.

Quick reference for DuneSQL -- the Trino-based query engine used by Dune. Use this when writing, debugging, or optimizing queries.

---

## Blockchain Data Types

DuneSQL extends standard SQL with types specific to on-chain data:

| Type        | Description                                                                         | Example                                      |
| ----------- | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| `varbinary` | Raw byte sequences. Used for addresses, transaction hashes, block hashes, calldata. | `0xd8da6bf26964af9d7eed9e03e53415d37aa96045` |
| `uint256`   | Unsigned 256-bit integer. Used for token amounts, balances, gas values.             | `1000000000000000000` (1 ETH in wei)         |
| `int256`    | Signed 256-bit integer. Used for values that can be negative (e.g. price deltas).   | `-500000000000000000`                        |
| `double`    | 64-bit floating point. Used for USD prices, percentages.                            | `1842.50`                                    |
| `timestamp` | Timestamp with timezone. Used for `block_time`.                                     | `2024-01-15 12:30:00 UTC`                    |

### Address Handling (Critical)

Addresses in Dune are stored as `varbinary`, not strings. This is the most common source of errors.

```sql
-- WRONG: comparing address to a string
SELECT * FROM ethereum.transactions
WHERE "from" = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'

-- CORRECT: use 0x prefix without quotes (varbinary literal)
SELECT * FROM ethereum.transactions
WHERE "from" = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045
```

To convert between formats:

```sql
-- varbinary to hex string (for display)
SELECT CAST(address AS varchar) FROM ethereum.transactions LIMIT 1

-- hex string to varbinary (for filtering)
SELECT * FROM ethereum.transactions
WHERE "from" = FROM_HEX('d8da6bf26964af9d7eed9e03e53415d37aa96045')
```

> **Note:** `FROM_HEX()` expects the address **without** the `0x` prefix, but the `0x` literal syntax includes it.

### Token Amount Handling

Token amounts are typically stored as `uint256` in raw form (no decimals). To get human-readable values:

```sql
-- Convert raw amount to human-readable (e.g. 18-decimal token like ETH/WETH)
SELECT
  CAST(value AS double) / POWER(10, 18) AS amount_eth
FROM ethereum.transactions

-- For tokens with different decimals (e.g. USDC = 6 decimals)
SELECT
  CAST(value AS double) / POWER(10, 6) AS amount_usdc
FROM erc20_ethereum.evt_Transfer
WHERE contract_address = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48  -- USDC
```

---

## Partition Columns & Query Performance

Most Dune tables are partitioned by time (typically `block_time` or `block_date`). **Always filter on partition columns** -- this is the single most impactful optimization for query speed and credit cost.

### Why It Matters

- Without a partition filter, Dune scans the **entire table** across all time
- With a partition filter, Dune only reads the relevant time range
- This can reduce scan size by 100-1000x and dramatically cut credit cost

### How to Identify Partition Columns

When searching for datasets, always use `--include-schema`:

```bash
dune dataset search --query "ethereum transactions" --include-schema -o json
```

Look for columns named `block_time`, `block_date`, `evt_block_time`, `call_block_time`, or `dt` in the schema output.

### Partition Filter Patterns

```sql
-- GOOD: filter on block_time (partition column)
SELECT COUNT(*) FROM ethereum.transactions
WHERE block_time >= NOW() - INTERVAL '7' DAY

-- GOOD: filter on block_date for date-level precision
SELECT COUNT(*) FROM ethereum.transactions
WHERE block_date >= DATE '2024-01-01'

-- GOOD: decoded event tables use evt_block_time
SELECT * FROM uniswap_v3_ethereum.evt_Swap
WHERE evt_block_time >= NOW() - INTERVAL '24' HOUR

-- GOOD: decoded call tables use call_block_time
SELECT * FROM uniswap_v3_ethereum.call_swap
WHERE call_block_time >= NOW() - INTERVAL '24' HOUR

-- BAD: no partition filter -- scans entire table history
SELECT COUNT(*) FROM ethereum.transactions

-- BAD: filtering only on non-partition columns
SELECT COUNT(*) FROM ethereum.transactions
WHERE "from" = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045
```

> **Rule:** Every query should include a `WHERE` clause on a partition column unless you explicitly need all-time data. Even then, consider whether a reasonable time bound exists.

---

## Common Functions

### Date & Time

```sql
-- Current time
NOW()

-- Time intervals
NOW() - INTERVAL '7' DAY
NOW() - INTERVAL '24' HOUR
NOW() - INTERVAL '30' MINUTE

-- Truncate to day/hour/week/month
DATE_TRUNC('day', block_time)
DATE_TRUNC('hour', block_time)
DATE_TRUNC('week', block_time)
DATE_TRUNC('month', block_time)

-- Extract components
EXTRACT(YEAR FROM block_time)
EXTRACT(MONTH FROM block_time)

-- Date arithmetic
DATE_ADD('day', 7, block_time)
DATE_DIFF('day', start_time, end_time)

-- Date literal
DATE '2024-01-01'
```

### Aggregation

```sql
-- Standard aggregations
COUNT(*), COUNT(DISTINCT column)
SUM(amount), AVG(amount)
MIN(value), MAX(value)

-- Approximate distinct count (faster for large datasets)
APPROX_DISTINCT(address)

-- Percentiles
APPROX_PERCENTILE(gas_price, 0.5)   -- median
APPROX_PERCENTILE(gas_price, 0.95)  -- 95th percentile

-- Array aggregation
ARRAY_AGG(token_address)
```

### String Functions

```sql
-- Lowercase (useful for case-insensitive matching)
LOWER(name)

-- Concatenation
CONCAT(first, ' ', last)
first || ' ' || last

-- Substring
SUBSTR(tx_hash_string, 1, 10)

-- Pattern matching
column LIKE '%uniswap%'
```

### Byte / Hex Functions

```sql
-- Convert hex string to varbinary
FROM_HEX('d8da6bf26964af9d7eed9e03e53415d37aa96045')

-- Convert varbinary to hex string
TO_HEX(address)

-- Get byte length
LENGTH(data)

-- Substring of bytes
SUBSTR(input_data, 1, 4)   -- first 4 bytes (function selector)

-- Keccak-256 hash
KECCAK256(data)
```

### Conditional & Type Conversion

```sql
-- CASE expressions
CASE
  WHEN amount > 1000 THEN 'whale'
  WHEN amount > 100 THEN 'dolphin'
  ELSE 'fish'
END

-- Coalesce (first non-null)
COALESCE(token_symbol, 'UNKNOWN')

-- Type casting
CAST(value AS double)
CAST(value AS varchar)
CAST(block_number AS bigint)
TRY_CAST(value AS double)   -- returns NULL instead of error
```

---

## Common Query Templates

### Daily Transaction Count for a Chain

```sql
SELECT
  DATE_TRUNC('day', block_time) AS day,
  COUNT(*) AS tx_count
FROM ethereum.transactions
WHERE block_time >= NOW() - INTERVAL '30' DAY
GROUP BY 1
ORDER BY 1
```

### Top Token Transfers by Value

```sql
SELECT
  contract_address AS token,
  "from",
  "to",
  CAST(value AS double) / POWER(10, 18) AS amount
FROM erc20_ethereum.evt_Transfer
WHERE evt_block_time >= NOW() - INTERVAL '24' HOUR
ORDER BY CAST(value AS double) DESC
LIMIT 100
```

### DEX Trade Volume (Spellbook)

```sql
SELECT
  DATE_TRUNC('day', block_time) AS day,
  project,
  SUM(amount_usd) AS volume_usd
FROM dex.trades
WHERE block_time >= NOW() - INTERVAL '7' DAY
  AND blockchain = 'ethereum'
GROUP BY 1, 2
ORDER BY 1, 3 DESC
```

### Wallet Activity Summary

```sql
SELECT
  COUNT(*) AS tx_count,
  MIN(block_time) AS first_seen,
  MAX(block_time) AS last_seen,
  COUNT(DISTINCT DATE_TRUNC('day', block_time)) AS active_days
FROM ethereum.transactions
WHERE "from" = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045
  AND block_time >= NOW() - INTERVAL '90' DAY
```

### Gas Price Analysis

```sql
SELECT
  DATE_TRUNC('hour', block_time) AS hour,
  AVG(CAST(gas_price AS double)) / 1e9 AS avg_gwei,
  APPROX_PERCENTILE(CAST(gas_price AS double) / 1e9, 0.5) AS median_gwei,
  APPROX_PERCENTILE(CAST(gas_price AS double) / 1e9, 0.95) AS p95_gwei
FROM ethereum.transactions
WHERE block_time >= NOW() - INTERVAL '24' HOUR
GROUP BY 1
ORDER BY 1
```

### Contract Event Count

```sql
SELECT
  topic0,
  COUNT(*) AS event_count
FROM ethereum.logs
WHERE contract_address = 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984
  AND block_time >= NOW() - INTERVAL '7' DAY
GROUP BY 1
ORDER BY 2 DESC
```

---

## Common Pitfalls

| Pitfall                                | Wrong                                                                                | Right                                                                                                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comparing addresses as strings         | `WHERE "from" = '0xabc...'`                                                          | `WHERE "from" = 0xabc...`                                                                                                                                                                                                                                                  |
| Missing partition filter               | `SELECT COUNT(*) FROM ethereum.transactions`                                         | Add `WHERE block_time >= NOW() - INTERVAL '7' DAY`                                                                                                                                                                                                                         |
| Not quoting reserved words             | `SELECT from, to FROM ...`                                                           | `SELECT "from", "to" FROM ...`                                                                                                                                                                                                                                             |
| Raw token amounts as readable          | `SELECT value FROM ...`                                                              | `CAST(value AS double) / POWER(10, decimals)`                                                                                                                                                                                                                              |
| `FROM_HEX` with 0x prefix              | `FROM_HEX('0xabc...')`                                                               | `FROM_HEX('abc...')` (no 0x)                                                                                                                                                                                                                                               |
| Using `TIMESTAMP` keyword              | `WHERE block_time > TIMESTAMP '2024-01-01'`                                          | `WHERE block_time > CAST('2024-01-01' AS timestamp)` or use `DATE '2024-01-01'`                                                                                                                                                                                            |
| Forgetting `GROUP BY` with agg         | `SELECT day, COUNT(*) ...`                                                           | Add `GROUP BY 1` or `GROUP BY day`                                                                                                                                                                                                                                         |
| Bigint overflow in arithmetic          | `SUM(gas_used * gas_price)`                                                          | `SUM(CAST(gas_used AS double) * CAST(gas_price AS double))` — always cast to `double` before multiplying or summing large integer columns (`gas_used`, `gas_price`, `value`, `uint256` fields) to avoid bigint overflow                                                    |
| Inferring identifiers from nearby data | Assuming a token ID range belongs to a project because it appeared in the same table | Always explicitly resolve identifiers (project IDs, pool addresses, token ID ranges) from a table/column that directly maps names to IDs. If the first table lacks the ID, search for other decoded tables that expose it. Never guess from co-located or positional data. |

---

## See Also

- [query-execution.md](query-execution.md) -- Execute queries and handle errors
- [dataset-discovery.md](dataset-discovery.md) -- Find tables before writing SQL
- [Dune Docs: Functions and Operators](https://docs.dune.com/query-engine/Functions-and-operators)
- [Dune Docs: Writing Efficient Queries](https://docs.dune.com/query-engine/writing-efficient-queries)
