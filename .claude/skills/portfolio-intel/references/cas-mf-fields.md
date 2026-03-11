# CAS-Style MF Portfolio Statement — Field Reference

## What is this format?

This format is produced by consolidated MF portfolio trackers and statement
services in India, including:

- **MF Central** (mfcentral.com) — Portfolio → Download
- **CAMS / KFintech** — Consolidated Account Statement (CAS) exports
- **Value Research Online** — Portfolio export
- **INDmoney, Kuvera, Groww "all holdings"** — consolidated exports
- **AMC-agnostic portfolio apps** — using CAS data feed

Filename pattern: `MF PORTFOLIO<DDMMYYYY>.csv` or `CAS_<date>.csv`

## File Format

Single CSV, one header row, one row per fund scheme.
No section markers. Last row is a `Grand Total :` summary row — skip it.

## Column Mapping

| CSV Column          | Internal Field         | Type   | Notes                                                                                                       |
| ------------------- | ---------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `Scheme with Folio` | `name` + `folioNumber` | string | Fund name followed by folio in `[...]`. Extract name before `(G)` or `(IDCW)`. Extract folio from brackets. |
| `Start date`        | `investmentStartDate`  | string | `DD-MM-YYYY` format                                                                                         |
| `Total Inv. Amount` | `totalInvestedAmount`  | number | Gross invested including redeemed portions. Commas in numbers — strip.                                      |
| `Total Redemption`  | `totalRedemption`      | number | Cumulative redemptions to date                                                                              |
| `Current Cost`      | `costBasisLocal`       | number | **Use this for cost basis.** = `Total Inv. Amount − Total Redemption` approximately                         |
| `Current Value`     | `currentValueLocal`    | number | **Primary value field.** Current NAV × Units held                                                           |
| `Dividend Payout`   | `dividendPayout`       | number | Cumulative dividends paid out (usually 0 for Growth plans)                                                  |
| `Dividend Reinvest` | `dividendReinvested`   | number | Cumulative dividends reinvested                                                                             |
| `Unrealized Gain`   | `unrealizedPnlLocal`   | number | `Current Value − Current Cost`. Can be negative.                                                            |
| `Realized Gain`     | `realizedPnlLocal`     | number | Gains locked in via past redemptions                                                                        |
| `XIRR`              | `xirr`                 | number | Annualized return % (Extended IRR). This is the best single-number return metric.                           |

**All values are in INR.** No currency column — assume `INR` for all rows.

## Name Parsing

Fund names follow this pattern:

```
{Scheme Name} ({Plan type}) {Direct/Regular} [{FolioNumber}]
```

Examples:

- `Parag Parikh Flexi Cap Fund (G) Direct [10742344]`
- `DSP Nifty Next 50 Index Fund (G) Direct [7141956/74]`
- `ICICI Pru Corporate Bond Fund (G) Direct [13036444/01]`

To extract clean name: strip everything from ` (G)` or ` (IDCW)` onwards.
Folio = content inside the last `[...]`.

All entries in this export are `Direct` plan (Growth). No need to check.

## Grand Total Row

The last valid data row starts with `Grand Total :` — **skip it** for holdings
processing. Read it only to cross-validate total `Current Value`.

The two rows after Grand Total are blank/zero-padding — also skip.

## Asset Class Classification

Use this keyword → asset class mapping (in priority order, check the lowercased name):

### Cash / Liquid (check first)

Keywords: `liquidity fund`, `liquid fund`, `money market`, `overnight`
→ `assetClass: cash`, `subClass: liquid_fund`, `geography: IN`

### Fixed Income / Debt

Keywords: `short term`, `low duration`, `corporate bond`, `gilt`, `psu bond`, `sdl`,
`banking and psu`, `credit risk`, `dynamic bond`, `floating rate`, `medium duration`,
`long duration`, `constant duration`
→ `assetClass: fixed_income`, `subClass: mutual_fund`, `geography: IN`

### Hybrid (split 60% equity / 40% fixed income)

Keywords: `balanced advantage`, `dynamic asset allocation`, `aggressive hybrid`,
`equity savings`, `arbitrage fund`
→ `assetClass: hybrid`, allocate 60% equity / 40% fixed_income, `geography: IN`

### Multi Asset (split 60% equity / 30% FI / 10% alternatives)

Keywords: `multi asset`, `asset allocation`
→ `assetClass: hybrid`, allocate 60% equity / 40% fixed_income, `geography: IN`

### International / Global Equity

Keywords: `overseas`, `developed world`, `international`, `global`, `emerging market`
**AND** NOT a debt/FI fund → `assetClass: equity`, `subClass: mutual_fund`, `geography: global`

Keywords for US-specific: `s&p 500`, `us total`, `nasdaq`
→ `assetClass: equity`, `subClass: mutual_fund`, `geography: US`

Note: Indian MFs investing overseas are still **INR-denominated** funds. Currency = INR.
Geography reflects the **underlying market exposure**, not the fund domicile.

### FoF (Fund of Funds) — check underlying exposure

`(FoF)` or `fof` or `fund of fund` in name:

- If contains `us`, `s&p`, `nasdaq` → `geography: US`
- If contains `world`, `global`, `developed`, `emerging`, `international` → `geography: global`
- Else → `geography: IN`

### Sector / Thematic Equity

Keywords: `healthcare`, `pharma`, `technology`, `banking`, `infra`, `consumption`,
`manufacturing`, `energy`, `realty`, `psu equity`, `defence`
→ `assetClass: equity`, `subClass: mutual_fund_sector`, `geography: IN`

### Flexi Cap / Multi Cap with overseas mandate

- **Parag Parikh Flexi Cap** and **Parag Parikh Tax Saver**: ~35% overseas by mandate
  → Split geography: 65% IN + 35% global

### All other equity (default)

Everything not matched above: index funds, large cap, mid cap, small cap, flexi cap,
ELSS, large & midcap → `assetClass: equity`, `subClass: mutual_fund`, `geography: IN`

## Geography Summary Rule

| Internal geography | Meaning                                             |
| ------------------ | --------------------------------------------------- |
| `IN`               | India-listed, India-underlying funds                |
| `global`           | International/global equity FoFs and overseas funds |
| `US`               | US-specific funds (S&P 500, US Total Market)        |

Currency is always `INR` regardless of geography (these are all Indian MF schemes).

## Notes

- **No units / NAV columns**: Cost basis and current value are pre-computed by the platform.
  Cannot reconstruct exact units from this format. For rebalancing calculations, use
  percentage of total value rather than unit-level math.
- **XIRR is per-fund**: The Grand Total XIRR is the blended portfolio XIRR — use it
  as the single headline return figure.
- **Realized gains**: The `Realized Gain` column captures profit from past redemptions.
  Include in total "all-time gain" = `Unrealized Gain + Realized Gain`.
- **SIP continuity**: `Start date` is the first investment date, not current SIP date.
  Do not use for performance period calculations.
