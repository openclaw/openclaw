Run a full portfolio refresh: ingest all available data sources, normalize to base currency, compute allocation and drift, and generate the portfolio brief.

$ARGUMENTS

## Process

1. Use the portfolio-analyst subagent to run the full normalization pipeline:
   - Read `data/portfolio/config.json`
   - Fetch or use cached FX rates (`data/portfolio/fx-rates.json`)
   - Parse IBKR positions CSV (`data/portfolio/ibkr/positions.csv`)
   - Parse Indian broker CSVs (`data/portfolio/india/*.csv`)
   - Load manual entries (`data/portfolio/manual/*.json`)
   - Build unified holdings list with FX-converted values
   - Compute allocation by asset class, geography, and currency
   - Compute drift vs targets from config
   - Flag concentration risks

2. Generate the full brief using the FULL_BRIEF template from the portfolio-intel SKILL.md

3. Save outputs:
   - Snapshot: `data/portfolio/snapshots/YYYY-MM-DD-portfolio.json`
   - Brief: `outputs/portfolio/brief.md` (overwrite)
   - Brief archive: `outputs/portfolio/history/YYYY-MM-DD-HH-MM-brief.md`

4. Confirm:
   - Total portfolio value in base currency
   - Sources ingested and their data dates
   - Any drift warnings
   - Any concentration flags
   - Snapshot path saved

## If $ARGUMENTS contains a file path

If a file path is provided (e.g. a new IBKR CSV or Zerodha CSV), ingest that file
first before running the refresh. Archive the old file before overwriting.

## Error handling

- Missing `config.json`: stop and tell the user to copy from `.claude/templates/portfolio-config.json.example`
- Missing IBKR CSV: continue without it, note in sources
- Missing India CSVs: continue without them, note in sources
- FX fetch failure: use cached rates, add stale warning to output
