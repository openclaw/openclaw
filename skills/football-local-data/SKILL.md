---
name: football_local_data
description: "Local football CSV datasets: local-data-fetch.mjs pulls registered sources — football-data-co-uk (HTTP CSV), http-csv (URLs), fbref (Python soccerdata → FBref/Sports Reference tables). Multi-source via --sources; fbref needs pip install soccerdata. Kaggle downloads live under football-match-analyst (kaggle-fetch.mjs). Research only; use --delay-ms; not betting advice."
metadata: { "openclaw": { "emoji": "📈", "requires": { "bins": ["node"] } } }
---

# Football local data

Bundled **`scripts/local-data-fetch.mjs`** downloads **CSV** files from one or more **registered sources** under `scripts/sources/`. The default source **`football-data-co-uk`** mirrors [Football-Data.co.uk](https://www.football-data.co.uk/) season files (`mmz4281/{season}/{LEAGUE}.csv`), with presets, multi-season ranges, and **`manifest.json`** checksums. The **`http-csv`** source fetches explicit **`--urls`** (any HTTPS CSV) for ad-hoc or third-party mirrors. **[Kaggle](https://www.kaggle.com/)** dataset downloads (API key–based) are integrated under the **`football-match-analyst`** skill — see **`scripts/kaggle-fetch.mjs`** there.

## Sources

| Id                        | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------- |
| **`football-data-co-uk`** | European league bundles (`--preset england                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | …   | all`), `--leagues`, or **`--urls`\*\* only (Football-Data URLs). |
| **`http-csv`**            | **`--urls` only** (optional **`--season`** for manifest label). Combine with **`football-data-co-uk`** when you need both preset bundles and extra URLs in one run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **`fbref`**               | **[FBref](https://fbref.com/)** (Sports Reference) via **Python** [soccerdata](https://soccerdata.readthedocs.io/): exports schedule, team/player season aggregates, and optional match-level tables. Requires **`pip install -r requirements-fbref.txt`** and **`python3`**. Use **`--preset all`** for every league id returned by **`FBref.available_leagues()`**, **`--leagues ALL`**, or country shortcuts (`england`, `spain`, …). Use **`--season-range 1993-2025`** (start years of European seasons) for long histories. **`--fbref-depth`**: `core` (default) = schedule + team/player season stat tables; `extended` = + team match tables; `full` = + player match tables (very large). **`--delay-ms`** is applied between table exports. **Not** a one-click mirror of every HTML table on the site — coverage follows soccerdata’s FBref reader. **Attribution**: cite [Sports Reference](https://www.sports-reference.com/) / FBref; respect their terms and rate limits. |
| **`all`**                 | Every **auto** source that does not need extra flags: currently **`football-data-co-uk`** only (**`http-csv`** and **`fbref`** are excluded — invoke them explicitly).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

For **`fbref`**, if requests are blocked (for example HTTP 403), route outbound traffic through a local proxy: **`--fbref-proxy http://127.0.0.1:PORT`**, or set **`HTTPS_PROXY`**, **`FBREF_PROXY`**, or **`ALL_PROXY`** to the same URL (your proxy client’s **HTTP** or **mixed** port on loopback — not the subscription URL).

**Multiple `--sources`:** each source writes under **`--out/<source_id>/`** (single source keeps files directly under **`--out`**).

**Legacy entry:** `scripts/football-data-fetch.mjs` imports the same engine (defaults to **`football-data-co-uk`** only via CLI defaults).

## Adding a source

1. Add **`scripts/sources/<id>.mjs`**. Either export URL builders (**`resolveSeasons`**, **`buildUrlsForSeason`**, **`validateArgs`**, …) like **`football-data-co-uk`**, **or** export **`runFetch(args, outRoot, ctx)`** for non-HTTP workflows (see **`fbref.mjs`**).
2. Register it in **`scripts/sources/registry.mjs`**. If the source should not run on `--sources all`, exclude it in **`allAutoSourceIds()`**.

## Compliance and ethics

- **Not betting advice**: research / modeling only.
- **Attribution**: cite Football-Data.co.uk and [notes](https://www.football-data.co.uk/notes.txt) when using that source; cite **Sports Reference / FBref** when using **`fbref`**.
- **Rate limits**: use **`--delay-ms`**; do not hammer hosts. FBref data is provided by Sports Reference under their terms.

## FBref troubleshooting (HTTP 403 / Cloudflare)

**FBref sits behind Cloudflare.** A normal **browser** may show **`https://fbref.com/en/`** after a short wait because the browser runs Cloudflare’s **JavaScript challenge** and keeps **cookies / session** for follow-up requests.

**`soccerdata`** (used by **`fbref-fetch.py`**) uses **`tls_requests`**, which does **not** behave like a full browser: it will **not** pass that challenge the same way, so you can see **403** from **`curl`**, scripts, or automation even when the site works in Chrome/Safari minutes later. **Changing IP alone** often does not fix this mismatch.

Mitigations (pick what fits your setup): route traffic through an **HTTP proxy** the browser also uses (`--fbref-proxy` / **`HTTPS_PROXY`**); run a **challenge-solving sidecar** (for example [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)) and point fetches at its proxy if you integrate it locally; use the **`football-data-co-uk`** source for CSV bundles; or rely on **permitted** manual export / licensing. There is **no** built-in Cloudflare bypass in this skill’s **`fbref`** path.

## Example commands

```bash
# Single source (default): England preset, current season inferred
node skills/football-local-data/scripts/local-data-fetch.mjs \
  --out ./var/football-data \
  --preset england

# Multiple sources: Football-Data presets + extra CSV URLs
node skills/football-local-data/scripts/local-data-fetch.mjs \
  --out ./var/football-data \
  --sources football-data-co-uk,http-csv \
  --preset england \
  --urls "https://example.com/extra.csv"

# FBref (install Python deps first: pip install -r requirements-fbref.txt)
# Optional: --fbref-proxy http://127.0.0.1:7890  (or HTTPS_PROXY / FBREF_PROXY)
node skills/football-local-data/scripts/local-data-fetch.mjs \
  --out ./var/fbref-data \
  --sources fbref \
  --preset all \
  --season-range 1993-2025 \
  --fbref-depth core \
  --delay-ms 500

# All auto-fetch sources (http-csv and fbref omitted unless listed explicitly)
node skills/football-local-data/scripts/local-data-fetch.mjs \
  --out ./var/football-data \
  --sources all \
  --preset england
```

## Relation to other skills

- **`football-match-analyst`** — API-backed **`llmPack`**; **`--provider football-data --csv`** expects **Football-Data.co.uk**-style CSV columns. **FBref** exports use a different schema (wide stat tables); use them in Python/pandas or your own pipelines, not as a drop-in for that provider.
