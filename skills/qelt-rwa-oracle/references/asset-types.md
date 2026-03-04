# QXMP Oracle — Asset Reference

## Asset Types

| Type | Description |
|------|-------------|
| `Gold` | Gold mining concessions and reserves |
| `Diamond` | Diamond mining reserves |
| `Rare Earth Elements` | Rare earth mining projects |
| `Heavy Mineral Sands` | Heavy mineral sand operations |
| `Nickel and Cobalt` | Nickel and cobalt operations |
| `Platinum` | Platinum group metals |
| `Lithium` | Lithium deposits |
| `Uranium` | Uranium deposits |

## Jurisdictions

| Code | Country |
|------|---------|
| `ZA` | South Africa |
| `NA` | Namibia |
| `MZ` | Mozambique |
| `LR` | Liberia |
| `AU` | Australia |
| `BW` | Botswana |

## Reporting Standards

| Standard | Description |
|----------|-------------|
| `NI 43-101` | National Instrument 43-101 (Canadian Securities Administrators) |
| `JORC` | Joint Ore Reserves Committee Code (Australasia) |
| `SAMREC` | South African Mineral Resource Committee Code |

## Known Asset Code Format

Asset codes follow the pattern: `QXMP:{PROJECT}-{STANDARD}-{JURISDICTION}`

Examples:
- `QXMP:RHENO-JORC-ZA` — Rhenosterspruit/Syferfontein Mining Project (JORC, South Africa)
- `QXMP:ATKA2-NI43-ZA` — Atka Platinum Project (NI 43-101, South Africa)

## Proof Freshness

| Status | Condition |
|--------|-----------|
| ✅ Fresh | `latestProof.isFresh === true` — proof submitted within 24 hours |
| ⚠️ Stale | `latestProof.isFresh === false` — proof is older than 24 hours |

The `ageHours` field gives exact hours since the last proof submission.

## Oracle Update Frequency

- Proofs update approximately **once per 24 hours**
- `latestProof.timestamp` shows the last proof submission time
- Recommended cache TTL: **2–5 minutes** for display; minimum 60 seconds

## Value Precision

- All `valueUSD` fields are returned as **strings** (not numbers)
- Parse with `parseFloat()` for arithmetic
- Values are stored on-chain with **8 decimal places** (encoded as `value * 10^8`)
- Example: `"113989838841.85"` represents $113,989,838,841.85 USD

## Total Portfolio

- **12 assets** currently registered
- Total value: approximately **$1.1 trillion USD**
- Portfolio spans: mining, rare earths, heavy minerals, precious metals
