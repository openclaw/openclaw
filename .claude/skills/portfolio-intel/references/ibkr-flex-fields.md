# IBKR Flex Query — Field Reference

## Flex Query Setup (recommended configuration)

In IBKR Client Portal or Trader Workstation:

- Reports → Flex Queries → Create/Edit Flex Query
- Statement Type: Activity
- Sections to include: **Open Positions** (required), Trades (optional for P&L)
- Format: CSV
- Period: Last Business Day (or as-of date)
- Delivery: Download manually or schedule via Flex Web Service

## File Format

IBKR Flex CSV exports are multi-section. Each section starts with a header row
(column names) followed by data rows. Sections are separated by blank lines or
a row where the first column changes to a new section name.

Example structure:

```
ClientAccountID,AccountAlias,...   ← Open Positions header
U1234567,,STK,AAPL,...             ← data row
U1234567,,STK,MSFT,...             ← data row
                                   ← blank line
ClientAccountID,AccountAlias,...   ← Trades header (if included)
```

**How to detect the Open Positions section:**
The header row for Open Positions always contains `ClientAccountID` as the first
column AND `PositionValue` or `MarkPrice` somewhere in the row. Skip any rows
before this header. Stop reading when you hit a blank line or a new section
header (a row where the first column is `ClientAccountID` but `MarkPrice` is
absent, or a row that starts with a known non-positions section name like
`Trades`, `CashReport`).

Some Flex exports prepend metadata rows like:

```
"Period","2026-03-11"
"Account","U1234567"
```

Skip all such two-column metadata rows before the first full header row.

## Open Positions — Column Mapping

| IBKR Column Name    | Internal Field           | Type   | Notes                                   |
| ------------------- | ------------------------ | ------ | --------------------------------------- |
| `ClientAccountID`   | `accountId`              | string | Map to `accounts[].id` in config        |
| `Symbol`            | `ticker`                 | string | e.g. `AAPL`, `SPY`, `VT`, `RELIANCE`    |
| `Description`       | `name`                   | string | Full security name                      |
| `AssetClass`        | `ibkrAssetClass`         | string | See mapping table below                 |
| `SubCategory`       | `ibkrSubCategory`        | string | `Common Stock`, `ETF`, `Mutual Fund`    |
| `Currency`          | `currency`               | string | ISO 4217 currency code                  |
| `Quantity`          | `quantity`               | number | Signed (negative = short position)      |
| `CostBasisPrice`    | `avgCostLocal`           | number | Per-unit cost in position currency      |
| `CostBasisMoney`    | `totalCostLocal`         | number | Total cost (absolute value)             |
| `MarkPrice`         | `currentPriceLocal`      | number | Last mark/close price                   |
| `PositionValue`     | `currentValueLocal`      | number | `Quantity × MarkPrice`                  |
| `UnrealizedPnL`     | `unrealizedPnlLocal`     | number | Mark-to-market unrealized P&L           |
| `FifoPnlUnrealized` | `unrealizedPnlFifoLocal` | number | FIFO unrealized P&L                     |
| `Side`              | `side`                   | string | `Long` or `Short`                       |
| `Multiplier`        | `contractMultiplier`     | number | 1 for stocks; 100 for US equity options |
| `Strike`            | `optionStrike`           | number | Options only; blank for stocks          |
| `Expiry`            | `optionExpiry`           | string | `YYYYMMDD`; blank for stocks            |
| `Put/Call`          | `optionType`             | string | `P` or `C`; blank for stocks            |
| `ReportDate`        | `asOfDate`               | string | `YYYY-MM-DD` or `YYYYMMDD`              |
| `Exchange`          | `exchange`               | string | e.g. `NASDAQ`, `NSE`, `LSE`             |
| `ConId`             | `ibkrConId`              | string | IBKR internal contract ID (ignore)      |

## Asset Class Mapping

| IBKR `AssetClass` | IBKR `SubCategory` | Internal `assetClass` | Internal `subClass`                             |
| ----------------- | ------------------ | --------------------- | ----------------------------------------------- |
| `STK`             | `Common Stock`     | `equity`              | `stock`                                         |
| `STK`             | `ETF`              | `equity`              | `etf`                                           |
| `STK`             | `Mutual Fund`      | `equity`              | `mutual_fund`                                   |
| `STK`             | (empty or other)   | `equity`              | `stock` — then check ETF override list          |
| `FND`             | any                | `equity`              | `etf`                                           |
| `BOND`            | any                | `fixed_income`        | `bond`                                          |
| `OPT`             | any                | `alternatives`        | `option` — **exclude from main P&L by default** |
| `FUT`             | any                | `alternatives`        | `future` — **exclude from main P&L by default** |
| `CASH`            | any                | `cash`                | `fx_balance` — **skip; use manual/cash.json**   |
| `FUND`            | any                | `equity`              | `mutual_fund`                                   |

**ETF override:** If `AssetClass = STK` and `SubCategory` is empty or `Common Stock`,
check the ticker against the known ETF list in `asset-taxonomy.md`. If found, override
`subClass` to `etf`.

## Geography Assignment from IBKR

Use `Exchange` field first. Fallback to ticker suffix.

| Exchange value                           | Geography                 | Notes                 |
| ---------------------------------------- | ------------------------- | --------------------- |
| `NASDAQ`, `NYSE`, `ARCA`, `BATS`, `CBOE` | `US`                      |                       |
| `NSE`, `BSE`                             | `IN`                      | Indian exchanges      |
| `LSE`                                    | `GB`                      | London Stock Exchange |
| `SGX`                                    | `SG`                      | Singapore Exchange    |
| `TSX`, `TSXV`                            | `CA`                      | Canada                |
| `ASX`                                    | `AU`                      | Australia             |
| `XETRA`, `IBIS`                          | `DE`                      | Germany               |
| (unknown)                                | derive from ticker suffix | see below             |

Ticker suffix fallback:

- `.NS` or `.BO` → `IN`
- `.L` → `GB`
- `.SI` → `SG`
- `.AX` → `AU`
- `.TO` → `CA`
- no suffix → `US` (default for IBKR US accounts)

Known global/international ETFs (geography = `global`):
`VT`, `VXUS`, `ACWI`, `IXUS`, `EFA`, `EEM`, `VEA`, `VWO`, `IEFA`, `IEMG`

## Trades Section — Column Mapping (optional)

Only read if user asks for realized P&L or recent trades.

| IBKR Column       | Internal Field     | Notes                               |
| ----------------- | ------------------ | ----------------------------------- |
| `TradeDate`       | `tradeDate`        | Filter to last 30 days for "recent" |
| `Symbol`          | `ticker`           |                                     |
| `AssetClass`      | `ibkrAssetClass`   |                                     |
| `Quantity`        | `quantity`         | Positive = buy, negative = sell     |
| `TradePrice`      | `tradePrice`       |                                     |
| `TradeMoney`      | `tradeValueLocal`  | `Quantity × TradePrice`             |
| `IBCommission`    | `commissionLocal`  | Typically negative                  |
| `FifoPnlRealized` | `realizedPnlLocal` | Blank for buys                      |
| `Currency`        | `currency`         |                                     |
| `Buy/Sell`        | `side`             | `BUY` or `SELL`                     |
| `OrderTime`       | `tradeTime`        |                                     |

## Common IBKR Quirks

1. **Options rows**: `Description` is often blank or encoded (e.g. `AAPL 20260320C00200000`).
   The `Symbol` column contains the encoded option symbol. Use `Description` for display only.

2. **Futures**: `Quantity` is in contracts, not underlying units. `PositionValue` already
   accounts for `Multiplier`, so use `PositionValue` directly.

3. **Negative cost basis**: Short positions can show negative `CostBasisMoney`. Use absolute
   value for cost basis; keep sign on `UnrealizedPnL`.

4. **Multi-currency P&L**: IBKR reports `UnrealizedPnL` in the position's local currency,
   not base currency. Convert using FX rates before summing.

5. **Partial fills / lot splitting**: If you see multiple rows for the same `Symbol`
   with different `CostBasisPrice`, they are separate lots. Sum `PositionValue` and
   `UnrealizedPnL` across all lots for the same ticker; use weighted average for display.

6. **USD CASH rows**: When a position's `AssetClass = CASH` and `Currency = USD`,
   it represents idle USD in the account. Skip and use `manual/cash.json` for cash tracking.
