Quick data freshness check — no calculations. Reports what data is available and how current it is.

## Process

Check each file and report its status. Do NOT parse or calculate anything — just report metadata.

1. **Config**
   - `data/portfolio/config.json`: exists? Base currency, N accounts, N asset class targets

2. **IBKR**
   - `data/portfolio/ibkr/positions.csv`: exists? Last modified date. First 2 lines preview.
   - `data/portfolio/ibkr/archive/`: how many archived files?

3. **India**
   - `data/portfolio/india/zerodha-holdings.csv`: exists? Last modified.
   - `data/portfolio/india/groww-holdings.csv`: exists? Last modified.

4. **Manual entries**
   - `data/portfolio/manual/property.json`: exists? `updatedAt` value, N entries.
   - `data/portfolio/manual/alternatives.json`: exists? `updatedAt`, N entries.
   - `data/portfolio/manual/cash.json`: exists? `updatedAt`, N accounts.

5. **FX rates**
   - `data/portfolio/fx-rates.json`: exists? `fetchedAt` value. How many hours ago?

6. **Last snapshot**
   - `data/portfolio/snapshots/`: most recent file name + date.

7. **Last brief**
   - `outputs/portfolio/brief.md`: exists? Last modified.

## Output format

```
📊 *Portfolio Data Status* — {today}

⚙️  Config: ✅ USD base, 2 accounts, 5 asset targets
📄  IBKR:   ✅ positions.csv — 10 Mar (1d old)
🇮🇳  Zerodha: ✅ zerodha-holdings.csv — 9 Mar (2d old)
🇮🇳  Groww:   ❌ not found
🏠  Property: ✅ 2 entries — updated 1 Mar (10d old)
💎  Alts:    ✅ 3 entries — updated 1 Mar (10d old)
💵  Cash:    ✅ 4 accounts — updated 8 Mar (3d old)
💱  FX:      ✅ fetched 4h ago
📸  Snapshot: ✅ 10 Mar snapshot exists
📝  Brief:   ✅ last generated 10 Mar

Ready for: /portfolio-refresh
```

Use ✅ for present and fresh, ⚠️ for present but stale (> 7 days), ❌ for missing.
