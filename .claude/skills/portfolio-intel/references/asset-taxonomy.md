# Asset Taxonomy Reference

## Asset Class Codes

| Code           | Label        | Description                                                          |
| -------------- | ------------ | -------------------------------------------------------------------- |
| `equity`       | Equity       | Stocks, ETFs, equity mutual funds, REITs listed on exchange          |
| `fixed_income` | Fixed Income | Bonds, debt mutual funds, government securities, FDs                 |
| `real_estate`  | Real Estate  | Physical property (residential, commercial), unlisted REITs          |
| `alternatives` | Alternatives | PE, angel/venture, options, futures, gold, commodities, collectibles |
| `cash`         | Cash         | Savings accounts, current accounts, liquid funds, FX balances        |

## Sub-Class Codes

| Sub-class     | Parent                | Description                                   |
| ------------- | --------------------- | --------------------------------------------- |
| `stock`       | equity                | Individual listed equity                      |
| `etf`         | equity                | Exchange-traded fund                          |
| `mutual_fund` | equity / fixed_income | Mutual fund scheme                            |
| `reit`        | real_estate           | Listed REIT / InvIT                           |
| `bond`        | fixed_income          | Individual bond                               |
| `option`      | alternatives          | Listed option contract                        |
| `future`      | alternatives          | Listed futures contract                       |
| `angel`       | alternatives          | Angel / seed investment                       |
| `pe`          | alternatives          | Private equity / VC fund                      |
| `gold`        | alternatives          | Gold ETF, SGB, physical gold                  |
| `residential` | real_estate           | Residential property                          |
| `commercial`  | real_estate           | Commercial property                           |
| `liquid_fund` | cash                  | Liquid / overnight MF (treated as near-cash)  |
| `fx_balance`  | cash                  | Foreign currency balance in brokerage account |

---

## Known ETF Tickers (IBKR — override STK → etf)

These tickers should be classified as `subClass: etf` even if IBKR reports `SubCategory: Common Stock`.

### US Broad Market

`SPY`, `IVV`, `VOO`, `VTI`, `ITOT`, `SCHB`, `SPDW`, `SCHD`

### US Sector / Factor

`QQQ`, `QQQM`, `XLK`, `XLF`, `XLE`, `XLV`, `XLI`, `XLC`, `XLY`, `XLP`,
`XLB`, `XLRE`, `XLU`, `GLD`, `SLV`, `IAU`, `PDBC`, `DJP`,
`VIG`, `NOBL`, `QUAL`, `MTUM`, `VLUE`, `SIZE`

### International

`VEA`, `VWO`, `EFA`, `EEM`, `IEFA`, `IEMG`, `VT`, `VXUS`, `ACWI`,
`IXUS`, `SCHF`, `SCHE`

### Fixed Income ETFs (reclassify → fixed_income)

`BND`, `BNDX`, `AGG`, `LQD`, `HYG`, `JNK`, `TLT`, `IEF`, `SHY`,
`VCIT`, `VCSH`, `VGIT`, `VGLT`, `EMB`, `IGLB`

### India ETFs (on IBKR — geography = IN)

`INDA`, `PIN`, `SMIN`, `INDY`, `EPI`

---

## Exchange Suffix → Geography Mapping

| Ticker suffix                 | Geography | Notes                        |
| ----------------------------- | --------- | ---------------------------- |
| (none, or US exchange listed) | `US`      | Default for IBKR US accounts |
| `.NS`                         | `IN`      | NSE listed                   |
| `.BO`                         | `IN`      | BSE listed                   |
| `.L`                          | `GB`      | London Stock Exchange        |
| `.SI`                         | `SG`      | Singapore Exchange           |
| `.AX`                         | `AU`      | ASX                          |
| `.TO`                         | `CA`      | TSX                          |
| `.TW`                         | `TW`      | Taiwan                       |
| `.HK`                         | `HK`      | Hong Kong                    |
| `.T`                          | `JP`      | Tokyo Stock Exchange         |
| `.DE` or `.F`                 | `DE`      | German exchanges             |
| `.PA`                         | `FR`      | Paris                        |
| `.AS`                         | `NL`      | Amsterdam                    |
| `.SW`                         | `CH`      | Switzerland                  |
| `.MC`                         | `ES`      | Madrid                       |

---

## Sector Codes (optional — for future sector allocation)

Standard GICS Level 1 sectors (used when IBKR provides sector data):

| Code               | Sector                                   |
| ------------------ | ---------------------------------------- |
| `energy`           | Energy                                   |
| `materials`        | Materials                                |
| `industrials`      | Industrials                              |
| `consumer_disc`    | Consumer Discretionary                   |
| `consumer_staples` | Consumer Staples                         |
| `healthcare`       | Health Care                              |
| `financials`       | Financials                               |
| `it`               | Information Technology                   |
| `comms`            | Communication Services                   |
| `utilities`        | Utilities                                |
| `real_estate_s`    | Real Estate (GICS sector — listed REITs) |

For ETFs (especially broad-market), sector = `diversified`.

---

## Geography Codes

Use ISO 3166-1 alpha-2 codes throughout:

| Code     | Label                                     |
| -------- | ----------------------------------------- |
| `US`     | United States                             |
| `IN`     | India                                     |
| `SG`     | Singapore                                 |
| `GB`     | United Kingdom                            |
| `DE`     | Germany                                   |
| `JP`     | Japan                                     |
| `CN`     | China                                     |
| `HK`     | Hong Kong                                 |
| `AU`     | Australia                                 |
| `CA`     | Canada                                    |
| `global` | Global/International (multi-country ETFs) |
| `other`  | Any country not listed above              |
