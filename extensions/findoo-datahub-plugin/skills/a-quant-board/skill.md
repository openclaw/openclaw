---
name: fin-a-quant-board
description: "A-share limit-up board quantitative analysis -- board ladder (consecutive limit-up tiers), theme main-line detection, sentiment cycle positioning, leader progression forecast, dragon-tiger institutional analysis, sector rotation rhythm. Use when: user asks about limit-up counts, consecutive boards, market sentiment cycle, theme main lines, leader stocks, dragon-tiger list analysis, or sector capital flow rotation. NOT for: individual stock fundamentals (use fin-a-share), concept lifecycle stage (use fin-a-concept-cycle), northbound flow (use fin-a-northbound-decoder), factor screening (use fin-factor-screen), macro data (use fin-macro)."
metadata:
  {
    "openclaw":
      { "emoji": "\ud83d\udd25", "requires": { "extensions": ["findoo-datahub-plugin"] } },
  }
---

# A-Share Limit-Up Board Quant & Theme Tracker

Use **fin_market**, **fin_index**, and **fin_stock** to quantify A-share limit-up board ecosystem: board ladder tiers, theme main-line identification, sentiment cycle positioning, leader progression forecast, and dragon-tiger institutional analysis. This skill covers the uniquely Chinese short-term trading culture built around daily price limits.

## When to Use

- "今天有几个连板" / "how many consecutive limit-ups today"
- "当前主线题材是什么" / "what is the main theme line"
- "现在情绪周期在哪个阶段" / "where are we in the sentiment cycle"
- "最高板是几板" / "what is the highest board count"
- "龙虎榜有哪些机构在买" / "which institutions are on the dragon-tiger list"
- "明天哪些股可能晋级" / "which stocks might advance tomorrow"
- "涨停数是多少" / "how many limit-ups today"
- "晋级率怎么样" / "what is the promotion rate"
- "板块资金在往哪流" / "where is sector capital flowing"
- "今天炸板多不多" / "were there many broken boards today"
- "赚钱效应怎么样" / "how is the profit-making effect"
- "现在是冰点还是高潮" / "is the market at freezing point or climax"

## When NOT to Use

- 个股基本面/PE/财务分析 -> use `/fin-a-share`
- 概念炒作生命周期/题材阶段判断 -> use `/fin-a-concept-cycle`
- 北向资金流向 -> use `/fin-a-northbound-decoder`
- 量化多因子选股 -> use `/fin-factor-screen`
- 宏观经济数据/GDP/CPI -> use `/fin-macro`
- 高股息/红利策略 -> use `/fin-a-dividend-king`
- 市场整体雷达/大盘复盘 -> use `/fin-a-share-radar`
- 美股/港股/加密货币 -> use respective market skills

## Tools & Parameters

### fin_market -- Limit-Up Board & Institutional Data

| Parameter  | Type   | Required | Format     | Default | Example           |
| ---------- | ------ | -------- | ---------- | ------- | ----------------- |
| endpoint   | string | Yes      | see table  | --      | market/limit_list |
| trade_date | string | Depends  | YYYY-MM-DD | --      | 2026-03-07        |
| date       | string | Depends  | YYYY-MM-DD | --      | 2026-03-07        |
| symbol     | string | Depends  | stock code | --      | 000001.SZ         |

#### Endpoints

| endpoint             | Description                  | Date param   | Example                                                              |
| -------------------- | ---------------------------- | ------------ | -------------------------------------------------------------------- |
| `market/limit_list`  | Limit-up/down stock list     | `trade_date` | `fin_market(endpoint="market/limit_list", trade_date="2026-03-07")`  |
| `market/top_list`    | Dragon-tiger list (daily)    | `date`       | `fin_market(endpoint="market/top_list", date="2026-03-07")`          |
| `market/top_inst`    | Institutional seat details   | `date`       | `fin_market(endpoint="market/top_inst", date="2026-03-07")`          |
| `market/stock_limit` | Individual stock limit price | `trade_date` | `fin_market(endpoint="market/stock_limit", symbol="000001.SZ")`      |
| `moneyflow/industry` | Sector capital flow          | `trade_date` | `fin_market(endpoint="moneyflow/industry", trade_date="2026-03-07")` |

### fin_index -- Concept/Theme Mapping

| Parameter | Type   | Required | Format               | Default | Example            |
| --------- | ------ | -------- | -------------------- | ------- | ------------------ |
| symbol    | string | Depends  | THS code `XXXXXX.TI` | --      | 885760.TI          |
| endpoint  | string | Yes      | see table            | --      | thematic/ths_index |
| limit     | number | No       | 1-5000               | 200     | 10                 |

#### Endpoints

| endpoint              | Description                | Example                                                                  |
| --------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `thematic/ths_index`  | All THS concept indices    | `fin_index(endpoint="thematic/ths_index")`                               |
| `thematic/ths_daily`  | Concept daily OHLCV        | `fin_index(symbol="885760.TI", endpoint="thematic/ths_daily", limit=10)` |
| `thematic/ths_member` | Concept constituent stocks | `fin_index(symbol="885760.TI", endpoint="thematic/ths_member")`          |

### fin_stock -- Individual Stock Validation

| Parameter | Type   | Required | Format         | Default | Example          |
| --------- | ------ | -------- | -------------- | ------- | ---------------- |
| symbol    | string | Yes      | `{code}.SH/SZ` | --      | 300024.SZ        |
| endpoint  | string | Yes      | see table      | --      | price/historical |
| limit     | number | No       | 1-5000         | 200     | 20               |

#### Endpoints

| endpoint               | Description           | Example                                                                   |
| ---------------------- | --------------------- | ------------------------------------------------------------------------- |
| `price/historical`     | Stock daily OHLCV     | `fin_stock(symbol="300024.SZ", endpoint="price/historical", limit=20)`    |
| `moneyflow/individual` | Individual stock flow | `fin_stock(symbol="300024.SZ", endpoint="moneyflow/individual", limit=5)` |

## A-Share Price Limit Rules

| Board                | Code prefix | Limit  | Notes                              |
| -------------------- | ----------- | ------ | ---------------------------------- |
| Main Board           | 600/601/000 | +/-10% | Standard                           |
| ST / \*ST            | ST prefix   | +/-5%  | Special treatment                  |
| ChiNext (创业板)     | 300xxx      | +/-20% | Harder to lock, stricter selection |
| STAR Market (科创板) | 688xxx      | +/-20% | Same as ChiNext                    |
| BSE (北交所)         | 8xxxxx      | +/-30% | Widest range                       |

Key limit-up terminology:

- **封单量** (seal order volume): pending buy orders holding the limit-up price; seal/float ratio measures lock strength
- **炸板** (broken board): limit-up opens then falls back -- divergence signal
- **回封** (re-seal): after breaking, price returns to limit-up -- dispute resolved bullishly
- **一字板** (one-line board): opens at limit-up and never opens -- extreme consensus, no entry opportunity
- **T字板** (T-shaped board): opens at limit-up, dips intraday, re-seals at close
- **天地板** (sky-to-ground board): limit-up to limit-down in same day -- extreme reversal
- **集合竞价** (call auction): 9:15-9:25 -- the most critical observation window for limit-up boards

## Analysis Patterns

### Pattern 1: Board Ladder Analysis (连板梯队分析)

1. **Fetch limit-up list** `fin_market(endpoint="market/limit_list", trade_date="YYYY-MM-DD")`
   - Get today's full limit-up stock list with consecutive board count

2. **Build the pyramid** -- Layer stocks by consecutive board days:

   ```
   Tier     Count    Meaning
   -----    -----    --------
   1-board  N        Market activity gauge
   2-board  N        Yesterday's 1-board survivors
   3-board  N        Momentum confirmation
   4-board  N        Theme leadership
   5-board+ N        Clear main-line theme
   Max-board N=1     Market height ceiling
   ```

3. **Interpret the pyramid**:
   - 1-board count: >60 = active market, 20-60 = normal, <20 = freezing point
   - **Promotion rate** = today's 2-board / yesterday's 1-board count
     - > 30% = strong consensus, market risk appetite high
     - 15-30% = normal
     - <15% = weak, market rejecting follow-through
   - Max board = market height; rising height = strengthening sentiment
   - 5-board+ usually corresponds to a clear main-line theme

4. **Compare with yesterday** -- fetch previous day's limit_list to calculate:
   - Promotion rate (2-board today / 1-board yesterday)
   - Height change (max board today vs yesterday)
   - Total limit-up trend (expanding/stable/contracting)

### Pattern 2: Theme Main-Line Detection (题材主线识别)

1. **Classify limit-ups by concept** `fin_market(endpoint="market/limit_list", trade_date="YYYY-MM-DD")`
   - Group today's limit-up stocks by industry/concept/theme

2. **Match THS concept indices** `fin_index(endpoint="thematic/ths_index")`
   - Find matching concept codes for concentrated limit-up clusters

3. **Validate concept trend** `fin_index(endpoint="thematic/ths_daily", symbol="concept_code", limit=10)`
   - Check concept index 10-day price trend for confirmation

4. **Main-line judgment criteria**:
   - Same concept limit-up >5 stocks + consecutive 2 days = **main line confirmed**
   - Single stock isolated limit-up = individual behavior, not a main line
   - New concept first-day >3 limit-ups = **potential new main line**
   - 2+ concepts with >5 limit-ups each = multi-main-line market (stronger sentiment)

5. **Output structure**:
   - Main Line 1: theme name + limit-up count + leader stock + consecutive days
   - Main Line 2: (secondary theme)
   - Main Line 3: (emerging/fading theme)
   - For each: leader stock + follower stocks + late-entry candidates

### Pattern 3: Sentiment Cycle Positioning (情绪周期判断)

Combine multiple dimensions to determine current sentiment cycle phase:

```
Freezing -> Recovery -> Fermentation -> Climax -> Divergence -> Retreat -> Freezing
(冰点)      (修复)       (发酵)          (高潮)    (分歧)        (退潮)     (冰点)
```

| Dimension         | Freezing   | Recovery  | Fermentation | Climax                 | Divergence       | Retreat         |
| ----------------- | ---------- | --------- | ------------ | ---------------------- | ---------------- | --------------- |
| Limit-up count    | <20        | 20-40     | 40-60        | 60-100                 | 50-70 (falling)  | 30-50 (falling) |
| Max board         | <=2        | 3         | 4-5          | 6+                     | Max breaks       | Cascading drops |
| Promotion rate    | <10%       | 15-25%    | 25-40%       | >40%                   | 20-30% (falling) | <15%            |
| Limit-down count  | >30        | 10-30     | <10          | <5                     | 10-20 (rising)   | 20-40 (rising)  |
| Action suggestion | Wait/probe | Light pos | Add position | Take profit / no chase | Reduce           | Stay empty      |

Steps:

1. `fin_market(endpoint="market/limit_list")` -- get limit-up count, max board, limit-down count
2. Calculate promotion rate from 2-day data
3. Score each dimension against the table
4. Determine majority phase -- if mixed signals, note "transition zone"

### Pattern 4: Leader Progression Forecast (龙头推演)

Based on today's data, project tomorrow's likely limit-up candidates:

1. **Promotion candidates**: yesterday's 1-board stocks that are likely to become 2-board
   - Strong seal order + main-line theme alignment + institutional participation = high probability
   - Weak seal / late-day limit-up / no clear theme = low probability

2. **Continuation candidates**: today's 2-board+ stocks that may advance further
   - Main-line theme + strong seal volume + institutional dragon-tiger buying = high certainty
   - Broken board then re-sealed = divergence resolved bullishly, often gaps up next day

3. **Assessment factors**:
   - Seal order / float market cap ratio: >5% = strong lock
   - Dragon-tiger institutional seats buying = institutional endorsement
   - Theme alignment: stock in today's main-line theme = higher continuation probability
   - Board timing: early-morning limit-up > afternoon limit-up > late-day limit-up

4. **Output**: ranked list of candidates with probability tier (high/medium/low) and reasoning

> WARNING: Forecasts are speculative reference only. Always state risk clearly. Past board performance does not guarantee continuation.

### Pattern 5: Dragon-Tiger Deep Analysis (龙虎榜深度分析)

1. **Fetch dragon-tiger list** `fin_market(endpoint="market/top_list", date="YYYY-MM-DD")`
   - Get stocks with unusual price moves triggering exchange disclosure

2. **Fetch institutional details** `fin_market(endpoint="market/top_inst", date="YYYY-MM-DD")`
   - Break down seat-level buy/sell amounts

3. **Analysis dimensions**:
   - **Known hot-money seats**: identify well-known speculator seats by trading patterns and size
   - **Institution vs hot-money ratio**: institutional buying = longer holding period; pure hot-money = quick flip
   - **Same seat multi-day appearance**: same buyer across consecutive days = orchestrated operation
   - **Buy/sell amount ratio**: net buy >> net sell = bullish conviction; balanced = distribution

4. **Cross-reference with board ladder**: dragon-tiger stocks that are also in the main-line theme with high board count = strongest conviction

### Pattern 6: Sector Rotation Rhythm (板块轮动节奏)

1. **Fetch sector capital flow** `fin_market(endpoint="moneyflow/industry", trade_date="YYYY-MM-DD")`
   - Track for 5 consecutive trading days

2. **Rotation signals**:
   - Sector first enters net-inflow Top 5 = **launch signal**
   - 3+ consecutive days of increasing net inflow = **main-line confirmed**
   - Absolute inflow high but decreasing day-over-day = **profit-taking phase**
   - Exits Top 10 = **rotation complete**, capital moving elsewhere

3. **Cross-validate with limit-up data**: sector with rising capital inflow + rising limit-up count = strongest rotation target

4. **Output**: sector rotation table (sector / 5-day cumulative flow / trend direction / stage / related limit-up stocks)

## Data Notes

- **Limit-up data**: `market/limit_list` available T+1 after market close (~18:00 CST)
- **Dragon-tiger list**: only disclosed for stocks with unusual moves (not every stock every day); exchange rules trigger disclosure
- **Sector flow**: `moneyflow/industry` provides daily aggregated flow data per sector
- **THS concept indices**: Tonghuashun (iFinD) concept indices, 400+ concepts, updated EOD
- **Promotion rate**: requires 2-day data; calculate manually from consecutive limit_list calls
- **Board count**: consecutive limit-up days field available in limit_list data
- **Intraday data** (seal orders, broken boards): not available via EOD endpoints; analysis based on EOD status flags
- **Call auction** (9:15-9:25): real-time observation only; not captured in EOD data

## Response Guidelines

### Number Format

- Limit-up count: 45 stocks (integer)
- Consecutive board: 5-board / 5连板 (integer + "board")
- Promotion rate: 28.5% (1 decimal)
- Seal order ratio: 6.2% (1 decimal)
- Capital flow: net inflow 12.3 yi RMB / 净流入 12.3 亿元
- Max board: 7-board (integer)
- Limit-down count: 8 stocks (integer)

### Must Include

- Board ladder pyramid (1-board through max-board with counts)
- Promotion rate with interpretation (strong/normal/weak)
- Current sentiment cycle phase with supporting evidence
- At least one main-line theme with leader stock identification
- Limit-up vs limit-down count comparison
- Clear action suggestion aligned with sentiment cycle phase

### Display Format

- **Daily board review**: pyramid + sentiment phase + main lines + leader forecast
- **Sentiment cycle query**: phase diagram with current position marked + multi-dimensional evidence table
- **Theme tracking**: main-line table (theme / limit-up count / leader / board count / status)
- **Dragon-tiger analysis**: seat-level table (seat name / buy amount / sell amount / net / stock / notes)
- Use directional language: "sentiment warming" / "main line rotating" / "promotion rate collapsing" / "height ceiling rising"
- Always include the cycle phase arrow: `冰点 -> 修复 -> [当前: 发酵] -> 高潮 -> 分歧 -> 退潮`
