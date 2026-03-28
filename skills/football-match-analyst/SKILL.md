---
name: football_match_analyst
description: "Football match analysis: match-context.mjs supports API-Football (default), Sportmonks, Nami, Opta, or local Football-Data.co.uk CSV (football-data, no API key); optional Kaggle CSV via scripts/kaggle-fetch.mjs (KAGGLE_USERNAME/KAGGLE_KEY) then football-data. Single --provider or multi --providers (parallel). Outputs llmPack. Use --date+teams or --fixture. Never claim guaranteed wins. Set env keys per provider you enable."
metadata: { "openclaw": { "emoji": "⚽", "requires": { "bins": ["node"] } } }
---

# Football match analyst

Help the user build a **match intelligence brief** grounded in **five dimensions** plus the model’s **qualitative reasoning**. The bundled script (`scripts/match-context.mjs`) returns **`llmPack`** (refined JSON) — **prefer that for the model** in single-provider mode. In **multi-provider** mode (`--providers a,b`), use **`bySource.<provider>.llmPack`** for each feed and compare; top-level **`llmPack`** mirrors **`primaryProvider`** (or the first successful source). Full `raw` blobs only appear with `--verbose`.

## Compliance and safety (mandatory)

- **Gambling**: Laws vary by jurisdiction. Do not encourage illegal betting. Any “betting” discussion is **hypothetical adult entertainment where legal**, not instructions to gamble.
- **Not financial advice**: Odds move; markets can be wrong. Past results and xG do not guarantee future outcomes.
- **API limits**: The script may call `/fixtures/statistics` (API-Football) or extra `/fixtures/{id}` includes (Sportmonks) up to **10+** times per run; free tiers may hit quotas — use `--last` conservatively.
- **Secrets**: Never paste `API_FOOTBALL_KEY`, `SPORTMONKS_TOKEN`, `NAMI_USER` / `NAMI_SECRET`, `OPTA_API_KEY`, or **`KAGGLE_KEY`** into chat. Use host env or `skills.entries.*.env` in config ([Skills config](/tools/skills-config)).

## Data providers (one per run, or several with `--providers`)

| Provider                      | Env                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API-Football** (default)    | `API_FOOTBALL_KEY`                           | Broad league coverage; injuries via `/injuries`; xG from `/fixtures/statistics` [API-Sports](https://www.api-football.com/).                                                                                                                                                                                                                                                                   |
| **Sportmonks**                | `SPORTMONKS_TOKEN` or `SPORTMONKS_API_TOKEN` | Rich feeds; sidelined/injuries and odds via fixture `include`; **post-match xG** often needs an [xG add-on](https://docs.sportmonks.com/v3/) on your plan. [MySportmonks](https://my.sportmonks.com/).                                                                                                                                                                                         |
| **Nami (纳米数据)**           | `NAMI_USER` + `NAMI_SECRET`                  | 足球资料库 API：HTTP 查询参数 **user + secret**（非 Header），商务合同常含 **IP 白名单**。默认路径对齐纳米「足球资料库」**v5**（如 `/api/v5/football/match/list`）；若与你购买的套餐不一致，用 `NAMI_PATH_*` / `NAMI_PARAM_*` 覆盖。[足球资料库接口说明](https://www.nami.com/zh/details/7j8gxi0to7inrql#interface)，[纳米数据](https://www.nami.com/zh)，[FAQ](https://www.nami.com/zh/faq)。 |
| **Opta / Stats Perform**      | `OPTA_API_BASE` + `OPTA_API_KEY`             | Opta 数据多经 **Stats Perform** 等合同 REST 交付；网关 URL、路径与鉴权因客户而异。脚本提供 **可配置 HTTP 适配器**（`OPTA_PATH_*`、`OPTA_AUTH_MODE` 等）。无球队搜索时设置 **`OPTA_HOME_TEAM_ID` / `OPTA_AWAY_TEAM_ID`**。参阅 [Stats Perform](https://www.statsperform.com/) / 合同技术文档。                                                                                                  |
| **Football-Data.co.uk (CSV)** | _(none)_                                     | **本地历史 CSV**（[Football-Data.co.uk](https://www.football-data.co.uk/) 格式，见 `notes.txt`）。**`--provider football-data`** + **`--csv path/to/E0.csv`** 或 **`FOOTBALL_DATA_CSV`** / **`FOOTBALL_DATA_CSV_PATH`**。无伤停；技术指标用 **HST/AST** 等列作 proxy。先用 bundled **`football-local-data`** 技能的 `local-data-fetch.mjs`（或 `football-data-fetch.mjs`）下载赛季文件。       |

**Kaggle community datasets (CSV, not a live match API):** use **`scripts/kaggle-fetch.mjs`** with the official **`kaggle`** CLI (`pip install -r requirements-kaggle.txt`). Auth with **`KAGGLE_USERNAME`** + **`KAGGLE_KEY`** (recommended for **`skills.entries.football_match_analyst.env`**) or **`~/.kaggle/kaggle.json`**. Download a dataset (e.g. **`hugomathien/soccer`**) then point **`--provider football-data --csv`** at a CSV from the extracted files. **`--mine`** batch-downloads datasets **you own** on Kaggle. See [Kaggle API](https://www.kaggle.com/docs/api); respect each dataset’s license.

**Single mode:** `--provider api-football` (default), `sportmonks`, `nami`, `opta` (alias `statsperform`), **`football-data`** (aliases `fd`, `football-data-co-uk`, `football-local-data`, `footballdatacouk`). Each `llmPack.dataSource` names the API or `football-data.co.uk`.

**Multi mode:** `--providers api-football,sportmonks` (comma- or semicolon-separated). The script **runs sources in parallel** and returns **`multiSource: true`**, **`bySource`** (per-provider full result including `llmPack`), **`primaryProvider`**, and top-level **`llmPack`** (copy of the primary slice for quick reads). Optional **`--primary-provider api-football`** picks which successful source seeds top-level `llmPack` (must appear in `--providers`). Sources missing credentials **fail individually** without blocking others; **`football-data`** only needs **`--csv`** (or **`FOOTBALL_DATA_CSV`**) instead of API keys. **OpenClaw:** put **all** required env keys in `skills.entries.football_match_analyst.env` when using multi (CSV path can live there as **`FOOTBALL_DATA_CSV`**).

### Credentials and OpenClaw config

1. Obtain API credentials from each vendor you use (API-Sports, Sportmonks, 纳米数据, Stats Perform / Opta, etc.) under your own contract.
2. **Do not** paste secrets into chat. Set credentials in the **host environment**, or inject them via **`skills.entries.football_match_analyst.env`** in `~/.openclaw/openclaw.json` so the gateway merges them into the skill process environment ([Skills config](/tools/skills-config)). For **single** `--provider`, include only that provider’s keys. For **`--providers`**, include **every** key needed (e.g. both `API_FOOTBALL_KEY` and `SPORTMONKS_TOKEN` when combining those two).

Example (placeholders only; include one provider’s keys per how you run the script):

```json
{
  "skills": {
    "entries": {
      "football_match_analyst": {
        "env": {
          "NAMI_USER": "your_user_id",
          "NAMI_SECRET": "your_secret",
          "NAMI_HOME_TEAM_ID": "12345",
          "NAMI_AWAY_TEAM_ID": "67890"
        }
      }
    }
  }
}
```

Multi-provider example (`--providers api-football,sportmonks` — include **both** key sets):

```json
{
  "skills": {
    "entries": {
      "football_match_analyst": {
        "env": {
          "API_FOOTBALL_KEY": "your_api_sports_key",
          "SPORTMONKS_TOKEN": "your_sportmonks_token"
        }
      }
    }
  }
}
```

Optional display names when using team ids: `NAMI_HOME_TEAM_NAME`, `NAMI_AWAY_TEAM_NAME`.

Same `skills.entries.football_match_analyst.env` shape for other providers, swapping in only the keys you need (or **combine** keys when using `--providers`):

- **API-Football (default `--provider`)**: `API_FOOTBALL_KEY`
- **Sportmonks**: `SPORTMONKS_TOKEN` or `SPORTMONKS_API_TOKEN`
- **Opta / Stats Perform**: `OPTA_API_BASE`, `OPTA_API_KEY`, and optional `OPTA_AUTH_MODE` / `OPTA_PATH_*` (see below)
- **Kaggle (for `kaggle-fetch.mjs` only)**: `KAGGLE_USERNAME`, `KAGGLE_KEY` (or `~/.kaggle/kaggle.json` instead)

### Kaggle fetch (then `football-data`)

```bash
pip install -r skills/football-match-analyst/requirements-kaggle.txt
node skills/football-match-analyst/scripts/kaggle-fetch.mjs --dataset hugomathien/soccer --out ./var/kaggle-soccer
# List CSVs you need, then:
node skills/football-match-analyst/scripts/match-context.mjs --provider football-data --csv ./var/kaggle-soccer/Match.csv --date YYYY-MM-DD --home "Team A" --away "Team B"
```

Batch-download **every dataset owned by your Kaggle account**: `node skills/football-match-analyst/scripts/kaggle-fetch.mjs --mine --out ./var/kaggle-mine` (see **`batch-manifest.json`** under **`--out`**).

### Opta / Stats Perform (contract-configurable REST)

Opta-powered feeds are usually delivered under a **customer-specific** Stats Perform (or partner) REST gateway — **there is no single public URL** baked into the script. Set:

- **`OPTA_API_BASE`** — HTTPS origin only (no trailing slash), e.g. your APIM or vendor base.
- **`OPTA_API_KEY`** — secret value (never paste into chat).
- **`OPTA_AUTH_MODE`** — `subscription` (default: `Ocp-Apim-Subscription-Key`), `bearer` (`Authorization: Bearer`), or `apikey` (custom header via **`OPTA_AUTH_HEADER`**, default `X-API-Key`).

**HTTP paths** (defaults are generic placeholders — **override to match your contract**):

- `OPTA_PATH_MATCH_BY_ID` — default `/matches/{matchId}`
- `OPTA_PATH_TEAM_FIXTURES` — default `/teams/{teamId}/fixtures`
- `OPTA_PATH_FIXTURES_BY_DATE` — default `/fixtures` (date via `OPTA_PARAM_DATE`, default `date`)
- `OPTA_PATH_H2H` — default `/fixtures/headtohead` (query keys `OPTA_PARAM_H2H_HOME` / `OPTA_PARAM_H2H_AWAY`, defaults `homeTeamId` / `awayTeamId`); if the call fails, the script **falls back** to merging team histories.
- `OPTA_PATH_TEAM_SEARCH` — optional; if unset, use **`OPTA_HOME_TEAM_ID`** and **`OPTA_AWAY_TEAM_ID`** (optional **`OPTA_HOME_TEAM_NAME`** / **`OPTA_AWAY_TEAM_NAME`** for labels).

**Response parsing**: set **`OPTA_JSON_MATCHES_KEY`** to a dot path if matches live under a nested key (e.g. `data.matches`). **`OPTA_FINISHED_STATUS`** lists strings treated as finished when mapping vendor status fields.

**Optional per-match endpoints** (if your plan exposes them): `OPTA_PATH_MATCH_STATS`, `OPTA_PATH_MATCH_INJURIES`, `OPTA_PATH_MATCH_ODDS` (templates may include `{matchId}`).

### Nami path and parameter overrides (when defaults do not match your contract)

Defaults follow the [足球资料库](https://www.nami.com/zh/details/7j8gxi0to7inrql#interface) product list (`/api/v5/football/match/list`, `match/schedule/season`, `season/table/detail`, `season/stats/detail`, `archive`). If your contract uses different paths or query keys, set:

- `NAMI_API_BASE` — gateway base (default `https://open.sportnanoapi.com`).
- `NAMI_PATH_TEAM_SEARCH`, `NAMI_PATH_MATCH_LIST`, `NAMI_PATH_TEAM_MATCHES`, `NAMI_PATH_MATCH_DETAIL`, `NAMI_PATH_SEASON_TABLE`, `NAMI_PATH_SEASON_STATS`, `NAMI_PATH_ARCHIVE` — HTTP paths.
- `NAMI_PARAM_KEYWORD` (default `keyword`), `NAMI_PARAM_START_TIME` / `NAMI_PARAM_END_TIME` (defaults `start_time` / `end_time`, used for day-window match lists), `NAMI_PARAM_TEAM_ID` (default `team_id`), `NAMI_PARAM_MATCH_ID` (default `match_id` for list/detail), `NAMI_PARAM_LIMIT` (default `limit`).
- `NAMI_MATCH_LIST_EXTRA` — JSON object merged into the match-list query (e.g. extra filters your package requires).
- `NAMI_SEASON_ID` + `NAMI_PARAM_SEASON_ID` (default `season_id`) when season endpoints need an explicit season.
- `NAMI_STATUS_FINISHED_IDS` — comma-separated status ids treated as finished (default `8,9,10,11,12`).

If your plan **does not** expose team search, set **`NAMI_HOME_TEAM_ID`** and **`NAMI_AWAY_TEAM_ID`** (and optional `NAMI_PATH_TEAM_SEARCH` only if search exists on your tier).

## Role (system behavior for the agent)

Act as a **professional football data analyst** (not a tipster service):

- **Do not** output absolute “must win / 100%” conclusions.
- **Do** output **probabilistic** language (e.g. “slight edge”, “high variance”, “data thin”).
- **Do** treat **script `llmPack` as the quantitative prior** and **web search** as the source for **motivation, suspensions not in API, travel, weather, derby narrative, and market rumors** (label rumors as rumor).

## Five core dimensions (what to cover)

1. **Fundamentals (实力底色)**  
   Strength baseline: from `llmPack.fundamentals` — sample size, W/D/L, GF/GA, goals per game, **home vs away splits** (venue splits).  
   Use `--last` 50–100 in the script for longer baselines.

2. **Technical depth (技术指标)**  
   From `llmPack.technicalLast5`: **last 5 xG and possession** (when the league/API provides stats).  
   If xG is missing, say so and rely on goals trend + qualitative style from reputable sources.  
   **Stoppage-time / late goals** (绝杀习惯): API coverage is inconsistent — **use web search** or state “data not available”.

3. **Personnel (人员与伤停)**  
   From `llmPack.injuries` + **web** for suspensions and confirmed XI.  
   Emphasize **key absences** (top scorer, spine CB/DM) when sources confirm.

4. **Motivation and context (战意与动力)**  
   **Not in the script** — **must** use web: relegation battle, title race, “dead rubber”, cup rest, derby / rivalry, international break fatigue.

5. **Market sentiment (市场情绪)**  
   From `llmPack.market` when present (odds snapshot).  
   Describe **directionally** (favorite drift, goals line) without claiming “inside information.”

**Fitness / schedule (体能周期)**  
 Use `llmPack.scheduleLoad` (matches in last 7 days before the match) plus **web** for **double match weeks**, **long travel**, **continental cup** (e.g. UCL) — the script does not know flight distance.

## Data priority (prompt strategy)

1. **First** compare `llmPack.technicalLast5` **last5AvgXgFor** and **last5AvgPossession** for both teams when xG rows exist.
2. If **top scorer / main ST is out** per injuries + news, **apply a qualitative downward adjustment** on that side’s goal expectation (e.g. **~0.5 goals** vs baseline) — **not a hard numeric guarantee**.
3. **Then** blend fundamentals (form + home/away) and H2H.
4. **Then** layer motivation, derby, and market.

## Structured output (required sections)

Use this Markdown structure (headings can be in **Chinese** as below):

1. **[核心数据对比]** — Table or bullets: form, home/away, GF/GA, last-5 xG/possession (or “N/A”), H2H summary.
2. **[关键伤停预警]** — Injuries/suspensions; impact on shape; **heuristic** striker-out adjustment if applicable.
3. **[战术博弈推演]** — Style matchup (press vs low block, transitions) when evidence exists; **do not invent** stats.
4. **[市场情绪与赔率]** — If `llmPack.market` exists, summarize; else say odds unavailable.
5. **[战意与场外因素]** — News-backed only; separate speculation.
6. **[概率与预测建议]** — **Probability bands**, not certainties; optional **betting-style** angles only where legal and user asked.

## Three-step pipeline (API + model)

**Step 1 — Script (host):** Resolve fixture (`--date` + `--home` / `--away`, or `--fixture ID`) and pull **aggregates + llmPack**.  
**Step 2 — Script:** Already computes **rolling averages** (goals, last-5 xG/possession, H2H, schedule load); **do not** paste huge `raw` JSON into the model unless debugging.  
**Step 3 — Model:** Ingest **`llmPack`** (or **`bySource`** in multi mode) + short user question; add **web search** for motivation, suspensions, travel, tactical notes, and **late-goal / injury-time** data if needed.

## Commands

```bash
export API_FOOTBALL_KEY="your_key_here"
# Typical: 50–100 game window for fundamentals
node skills/football-match-analyst/scripts/match-context.mjs \
  --date 2026-03-30 \
  --home "Manchester United" \
  --away "Liverpool" \
  --last 80

# Sportmonks (same args; different env + token)
export SPORTMONKS_TOKEN="your_token_here"
node skills/football-match-analyst/scripts/match-context.mjs \
  --provider sportmonks \
  --date 2026-03-30 \
  --home "Manchester United" \
  --away "Liverpool" \
  --last 80

# Direct fixture id (skips name resolution)
node skills/football-match-analyst/scripts/match-context.mjs --fixture 12345678 --last 50
node skills/football-match-analyst/scripts/match-context.mjs --provider sportmonks --fixture 12345678

# Nami (纳米数据) — credentials from your contract; optional NAMI_PATH_* overrides
export NAMI_USER="your_user"
export NAMI_SECRET="your_secret"
node skills/football-match-analyst/scripts/match-context.mjs \
  --provider nami \
  --date 2026-03-30 \
  --home "主队名" \
  --away "客队名" \
  --last 50

# Opta / Stats Perform — set gateway + key; align OPTA_PATH_* to your contract
export OPTA_API_BASE="https://your-gateway.example.com"
export OPTA_API_KEY="your_key"
export OPTA_HOME_TEAM_ID="12345"
export OPTA_AWAY_TEAM_ID="67890"
node skills/football-match-analyst/scripts/match-context.mjs \
  --provider opta \
  --date 2026-03-30 \
  --home "Home FC" \
  --away "Away FC" \
  --last 50

# Multi-provider (parallel; set env for each source — here API-Football + Sportmonks)
export API_FOOTBALL_KEY="your_key_here"
export SPORTMONKS_TOKEN="your_token_here"
node skills/football-match-analyst/scripts/match-context.mjs \
  --providers api-football,sportmonks \
  --primary-provider api-football \
  --date 2026-03-30 \
  --home "Manchester United" \
  --away "Liverpool" \
  --last 50

# Football-Data.co.uk CSV (no API key; download CSVs with football-local-data/scripts/local-data-fetch.mjs first)
node skills/football-match-analyst/scripts/match-context.mjs \
  --provider football-data \
  --csv skills/football-local-data/data/latest/E0.csv \
  --date 2025-08-16 \
  --home "Arsenal" \
  --away "Wolves" \
  --last 50
# Or: export FOOTBALL_DATA_CSV="skills/football-local-data/data/latest/E0.csv"
# Row index mode: internal fixture id is csv-N (N = row index); --fixture 0 selects first data row

# Include heavy raw arrays for debugging only
node skills/football-match-analyst/scripts/match-context.mjs --date 2026-03-30 --home "A" --away "B" --verbose
```

Output top-level keys:

**Single provider**

- **`llmPack`** — **Primary** input for analysis (schemaVersion 2).
- **`meta.warnings`** — Ambiguous names, missing fixture on date, etc.
- **`raw`** — Only if `--verbose`.

**Multi provider** (`--providers` with two or more)

- **`multiSource`** — `true`.
- **`bySource`** — map of provider id → full single-provider result (`llmPack`, `meta`, `query`, optional `raw`).
- **`primaryProvider`** — which source was used for top-level `llmPack`.
- **`llmPack`** — copy of **`bySource[primaryProvider].llmPack`** for quick reads (or first successful).
- **`meta.combinedWarnings`** — prefixed per source (`[api-football] …`).

## When not to use

- Non-football sports.
- User cannot provide API key, has **no** suitable Football-Data CSV on disk, and refuses **web-only** qualitative mode.

## If API key is missing

If the user can place a **Football-Data.co.uk** season CSV locally (see bundled `football-local-data` fetch script), prefer **`--provider football-data`** with **`--csv`** or **`FOOTBALL_DATA_CSV`** — same **`llmPack`** shape without vendor keys (historical limits apply; injuries often empty). Otherwise offer **web-only** analysis with explicit caveats on missing xG aggregates and odds.
