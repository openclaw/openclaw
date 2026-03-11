Ingest a new IBKR Flex Query CSV export into the portfolio data store.

$ARGUMENTS

## What this does

Validates, archives, and installs a new IBKR positions CSV file so the next
portfolio refresh picks it up correctly.

## Process

1. Locate the CSV file:
   - If $ARGUMENTS contains a file path: use that path
   - Otherwise: look for the most recently modified `.csv` file in `data/portfolio/ibkr/`
     that is NOT already named `positions.csv`

2. Validate the file:
   - Confirm it has a header row containing `ClientAccountID` and `PositionValue`
     (see `references/ibkr-flex-fields.md` for parsing rules)
   - Confirm it has at least 1 data row in the Open Positions section
   - Extract and report:
     - `ReportDate` from the data rows
     - Account ID(s) present
     - Total row count
     - Asset class breakdown (count by IBKR AssetClass)

3. Archive the current `positions.csv` (if it exists):
   - Copy to `data/portfolio/ibkr/archive/YYYY-MM-DD-positions.csv`
     (use today's date, or the `ReportDate` from the old file if known)

4. Install the new file:
   - Copy/rename the new file to `data/portfolio/ibkr/positions.csv`

5. Confirm:

```
✅ IBKR positions ingested
Report date: {date from file}
Account: {accountId}
Positions: {N} rows
Asset classes: STK={N}, BOND={N}, OPT={N}
Archived old file: ibkr/archive/{filename}
Ready to refresh. Run: /portfolio-refresh
```

## Validation failures

- If `ClientAccountID` column is missing: report error, do not overwrite
- If 0 data rows found: report error, do not overwrite
- If file appears to be a Trades export (no `PositionValue` column): report error,
  suggest the user re-run the Flex Query with "Open Positions" section enabled
