# Indian Broker CSV Field Reference

## Zerodha

### Export Path

Console (console.zerodha.com) → Portfolio → Holdings → Download

### File Format

Plain CSV, single header row, no section markers.

### Field Mapping

| Zerodha Column | Internal Field       | Notes                                               |
| -------------- | -------------------- | --------------------------------------------------- |
| `Instrument`   | `name`               | Full instrument name (e.g. "RELIANCE", "NIFTYBEES") |
| `ISIN`         | `isin`               | 12-char ISIN (INF... = MF, IN... = equity)          |
| `Qty.`         | `quantity`           | Units / shares held                                 |
| `Avg. cost`    | `avgCostLocal`       | INR per unit (cost price)                           |
| `LTP`          | `currentPriceLocal`  | Last traded price in INR                            |
| `Cur. val`     | `currentValueLocal`  | Current value in INR                                |
| `P&L`          | `unrealizedPnlLocal` | Unrealized P&L in INR                               |
| `Net chg.`     | `unrealizedPnlPct`   | % change from avg cost                              |
| `Day chg.`     | `dayChangePct`       | Today's % change                                    |

### Asset Class Classification

1. **ETF**: name contains "ETF", "BEES", "IETF", "1D" (liquid ETF), or ISIN starts with `INF`
   and name contains known ETF keywords → `equity`, `subClass: etf`

2. **Mutual Fund**: ISIN starts with `INF` and NOT an ETF by above rule →
   `equity`, `subClass: mutual_fund` (or `fixed_income` if name contains "Debt", "Liquid",
   "Overnight", "Money Market", "Bond", "Gilt", "Duration")

3. **Direct Equity**: ISIN starts with `IN` (not `INF`) → `equity`, `subClass: stock`

4. **SGBs (Sovereign Gold Bonds)**: name contains "SGB" → `alternatives`, `subClass: gold`

5. **REITs**: name contains "REIT" or "InvIT" → `real_estate`, `subClass: reit`

**All geography = `IN` for Zerodha holdings** (India-listed instruments only).
**All currency = `INR`** unless instrument is explicitly a US ETF feeder fund.

### ISIN Prefix Reference

| Prefix       | Type                                             |
| ------------ | ------------------------------------------------ |
| `INF`        | Mutual fund / ETF unit (SEBI-registered schemes) |
| `IN` (other) | Indian equity, REITs, InvITs, SGBs               |

---

## Groww

### Export Path

Groww app → Mutual Funds → Portfolio → Download (top-right icon)

### File Format

CSV with header row. Column names differ from Zerodha.

### Field Mapping

| Groww Column      | Internal Field       | Notes                                               |
| ----------------- | -------------------- | --------------------------------------------------- |
| `Fund Name`       | `name`               | Full scheme name                                    |
| `Units`           | `quantity`           | Units held                                          |
| `NAV`             | `currentPriceLocal`  | Current NAV in INR                                  |
| `Current Value`   | `currentValueLocal`  | INR                                                 |
| `Invested Amount` | `totalCostLocal`     | Total invested INR                                  |
| `Returns`         | `unrealizedPnlLocal` | Absolute return in INR                              |
| `Returns %`       | `unrealizedPnlPct`   | % return                                            |
| `Type`            | `fundType`           | `Equity`, `Debt`, `Hybrid`, `Gold`, `International` |
| `Scheme Code`     | `schemeCode`         | AMFI scheme code (ignore)                           |

### Asset Class from Groww `Type`

| Groww `Type`    | Internal `assetClass` | Internal `subClass` | Notes                                        |
| --------------- | --------------------- | ------------------- | -------------------------------------------- |
| `Equity`        | `equity`              | `mutual_fund`       |                                              |
| `Debt`          | `fixed_income`        | `mutual_fund`       |                                              |
| `Hybrid`        | split                 | `mutual_fund`       | 60% equity / 40% fixed_income for allocation |
| `Gold`          | `alternatives`        | `gold`              |                                              |
| `International` | `equity`              | `mutual_fund`       | geography = `global`                         |
| `Liquid`        | `cash`                | `liquid_fund`       | Treat as near-cash                           |

**All currency = `INR`** (Groww is India-only).
**Geography = `IN`** unless `Type = International` → `global`.

### Computing Cost Basis

Groww does not export a per-unit cost column directly. Compute:

```
avgCostLocal = totalCostLocal / quantity
```

---

## MF Central (future)

When MF Central API access is set up, it will replace manual CSV downloads
for all AMFI-registered mutual funds. Placeholder: skip for now.

---

## Deduplication Rules

When both Zerodha and Groww exports are present, some schemes may appear in both
(e.g. if user holds direct plans on Zerodha and regular on Groww).

Dedup rule: if `name` strings are > 80% similar (ignore "Direct" / "Regular" / "Growth" /
"IDCW" suffixes), group them as separate lots under the same scheme. Do NOT merge values —
keep them as distinct positions with a `(lot 1)` / `(lot 2)` suffix.
