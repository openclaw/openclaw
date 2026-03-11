---
name: fin-a-concept-cycle
description: "A-share concept/theme hype cycle analysis — lifecycle stage detection (launch/ferment/climax/decay), leader identification, limit-up statistics, decay warning. Use when: user asks if a concept/theme is still tradeable, what stage a hot sector is in, which concepts are trending, or how long a theme rally lasts. NOT for: individual stock deep analysis (use fin-a-share), policy-to-sector mapping (use fin-a-policy-alpha), market-wide sentiment/limit-up board (use fin-a-quant-board), factor screening (use fin-factor-screen)."
metadata:
  {
    "openclaw":
      { "emoji": "\ud83c\udf00", "requires": { "extensions": ["findoo-datahub-plugin"] } },
  }
---

# A-Share Concept Hype Cycle

Use **fin_index** (thematic endpoints) and **fin_market** to quantify concept/theme speculation lifecycle in A-shares. Core insight: concept hype follows a predictable 4-stage lifecycle (launch -> ferment -> climax -> decay), and each stage has measurable signals.

## When to Use

- "AI概念还能追吗" / "is the AI concept still tradeable"
- "机器人板块到什么阶段了" / "what stage is the robotics sector in"
- "概念股炒作周期怎么看" / "how to read concept hype cycles"
- "现在什么概念最热" / "which concepts are hottest right now"
- "这个题材还能持续多久" / "how long will this theme last"
- "龙头是哪只" / "which stock is the leader"
- "板块要退潮了吗" / "is the sector about to fade"

## When NOT to Use

- 个股基本面/筹码/技术面分析 -> use `/fin-a-share`
- 政策出台到板块映射 -> use `/fin-a-policy-alpha`
- 涨停板/情绪周期/赚钱效应 -> use `/fin-a-quant-board`
- 北向资金方向 -> use `/fin-a-northbound-decoder`
- 量化多因子选股 -> use `/fin-factor-screen`
- 市场整体雷达/复盘 -> use `/fin-a-share-radar`
- 高股息/红利策略 -> use `/fin-a-dividend-king`
- 宏观经济数据 -> use `/fin-macro`

## Tools & Parameters

### fin_index -- Concept/Theme Data

| Parameter  | Type   | Required | Format               | Default | Example            |
| ---------- | ------ | -------- | -------------------- | ------- | ------------------ |
| symbol     | string | Depends  | THS code `XXXXXX.TI` | --      | 885760.TI          |
| endpoint   | string | Yes      | see table below      | --      | thematic/ths_index |
| start_date | string | No       | YYYY-MM-DD           | --      | 2026-02-01         |
| end_date   | string | No       | YYYY-MM-DD           | --      | 2026-03-07         |
| limit      | number | No       | 1-5000               | 200     | 30                 |

#### Endpoints

| endpoint              | Description                | Example                                                                  |
| --------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `thematic/ths_index`  | All THS concept indices    | `fin_index(endpoint="thematic/ths_index")`                               |
| `thematic/ths_daily`  | Concept daily OHLCV        | `fin_index(symbol="885760.TI", endpoint="thematic/ths_daily", limit=20)` |
| `thematic/ths_member` | Concept constituent stocks | `fin_index(symbol="885760.TI", endpoint="thematic/ths_member")`          |

### fin_market -- Limit-Up & Institutional Flow

| Parameter  | Type   | Required | Format     | Default | Example           |
| ---------- | ------ | -------- | ---------- | ------- | ----------------- |
| endpoint   | string | Yes      | see table  | --      | market/limit_list |
| trade_date | string | Depends  | YYYY-MM-DD | --      | 2026-03-07        |
| date       | string | Depends  | YYYY-MM-DD | --      | 2026-03-07        |

#### Endpoints

| endpoint             | Description         | Example                                                              |
| -------------------- | ------------------- | -------------------------------------------------------------------- |
| `market/limit_list`  | Limit-up/down stats | `fin_market(endpoint="market/limit_list", trade_date="2026-03-07")`  |
| `market/top_list`    | Dragon-tiger list   | `fin_market(endpoint="market/top_list", date="2026-03-07")`          |
| `market/top_inst`    | Institutional seats | `fin_market(endpoint="market/top_inst", date="2026-03-07")`          |
| `moneyflow/industry` | Sector capital flow | `fin_market(endpoint="moneyflow/industry", trade_date="2026-03-07")` |

### fin_stock -- Individual Stock Validation

| Parameter | Type   | Required | Format         | Default | Example          |
| --------- | ------ | -------- | -------------- | ------- | ---------------- |
| symbol    | string | Yes      | `{code}.SH/SZ` | --      | 300024.SZ        |
| endpoint  | string | Yes      | see table      | --      | price/historical |
| limit     | number | No       | 1-5000         | 200     | 20               |

#### Endpoints

| endpoint           | Description       | Example                                                                |
| ------------------ | ----------------- | ---------------------------------------------------------------------- |
| `price/historical` | Stock daily OHLCV | `fin_stock(symbol="300024.SZ", endpoint="price/historical", limit=20)` |

## Concept Lifecycle Model

```
Stage 1: LAUNCH (Day 1-2)
  Catalyst: news/policy/event triggers initial interest
  Signals: 1-3 stocks limit-up, concept index +1-3%, low volume
  Leader: first stock to hit limit-up = proto-leader
  Action: early entry opportunity, small position

Stage 2: FERMENT (Day 3-5)
  Signals: 5-15 stocks limit-up, concept index +3-8% cumulative,
           volume 2-3x normal, dragon-tiger shows institutional buying
  Leader: 2-4 consecutive limit-ups, highest recognition
  Action: follow the leader, add on confirmation

Stage 3: CLIMAX (Day 6-8)
  Signals: 15+ stocks limit-up, concept index acceleration slows,
           turnover rate peaks (>8%), laggards start catching up
  Leader: may show first "open limit-up" (封板后打开)
  Action: DANGER ZONE -- do not chase, take partial profit

Stage 4: DECAY (Day 9+)
  Signals: leader breaks consecutive limit-ups,
           concept index falls while laggards still rise (divergence),
           "大面" appears (limit-up to limit-down same day),
           turnover drops sharply
  Leader: drops while 2nd/3rd tier stocks have final spike
  Action: EXIT -- concept is exhausted
```

## Concept Cycle Analysis Pattern

1. **Identify the Concept** `fin_index(thematic/ths_index)` -- Find the THS concept code
   - Search concept list by keyword (e.g., "机器人", "AI", "新能源")
   - Note the concept code (e.g., 885760.TI) for subsequent queries
   - If user mentions a stock, use `fin_index(thematic/ths_member)` to find which concepts it belongs to

2. **Assess Current Stage** `fin_index(thematic/ths_daily, symbol=concept_code, limit=20)` -- Lifecycle positioning
   - Calculate: cumulative gain from trough, daily gain slope, volume trend
   - Day count: identify start date (first day of consecutive gains after flat period)
   - Turnover rate trend: rising = still in play; peaking = climax; falling = decay
   - Compare against lifecycle model above to determine current stage

3. **Limit-Up Validation** `fin_market(market/limit_list, trade_date=recent_dates)` -- Breadth and momentum
   - Count limit-up stocks related to this concept across last 3-5 days
   - Trend: expanding (ferment) vs stable (climax) vs contracting (decay)
   - Consecutive limit-up distribution: how many are 2-board, 3-board, etc.
   - "Big face" count (涨停后炸板 or 天地板): >2 per day = decay signal

4. **Leader Identification** `fin_index(thematic/ths_member)` + `fin_stock(price/historical)` -- Who leads
   - Get concept constituent stocks
   - Filter: first to limit-up + most consecutive limit-ups + highest total gain
   - Leader traits: earliest start + highest board count + strongest recognition + volume holds
   - If leader breaks board (断板): concept likely entering climax/decay transition

5. **Capital Flow Cross-Check** `fin_market(moneyflow/industry)` + `fin_market(market/top_list)` -- Smart money direction
   - Sector capital flow: net inflow = concept has real money backing; net outflow = fading
   - Dragon-tiger list: institutional seats buying = institutional participation (longer cycle)
   - Dragon-tiger list: only retail/游资 seats = pure speculation (shorter cycle, faster decay)
   - Northbound flow into concept stocks (optional): `fin_market(flow/hsgt_top10)` -- foreign participation extends cycle

6. **Decay Warning Synthesis** -- Combine all signals
   - Leader breaks consecutive boards + concept index gain narrows + limit-up count drops 50% = DECAY CONFIRMED
   - Laggards rising while leaders falling = final divergence phase (exit immediately)
   - Turnover rate > 15% on concept index = exhaustion imminent
   - All sector fund flow turns negative for 2+ consecutive days = funds exiting

## Historical Concept Duration Reference

| Concept Type      | Typical Duration | Leader Gain | Example                     |
| ----------------- | ---------------- | ----------- | --------------------------- |
| Policy-driven     | 8-15 days        | 50-100%     | New energy 2021, Chips 2023 |
| Event-driven      | 3-7 days         | 30-60%      | ChatGPT Feb 2023            |
| Earnings surprise | 5-10 days        | 20-40%      | Sector-wide beat            |
| Pure speculation  | 2-5 days         | 20-50%      | Meme-style themes           |
| Tech revolution   | 15-30 days       | 80-200%     | AI/Robotics 2024-2025       |

Duration affected by: policy reinforcement (extends), market regime (bull extends, bear shortens), institutional participation (extends), pure retail (shortens).

## Data Notes

- **THS concept index**: Tonghuashun (iFinD) concept indices, updated EOD ~18:00 CST
- **Concept list**: `ths_index` returns all THS concepts (400+), filter by keyword
- **Limit-up data**: `limit_list` available T+1 after close
- **Dragon-tiger list**: only on days with unusual moves (not every day for every stock)
- **Day count**: manual calculation from concept daily data; no explicit "hype start date" field
- **Turnover rate**: available in `ths_daily` data for concept index level

## Response Guidelines

### Number Format

- Concept index gain: +12.5% (cumulative), +3.2% (daily)
- Limit-up count: 15 stocks (integer)
- Consecutive boards: 5-board (integer + "board/连板")
- Turnover rate: 8.3% (1 decimal)
- Day count: Day 5 of cycle (integer)
- Capital flow: net inflow 8.2 yi RMB

### Must Include

- Current lifecycle stage (Launch/Ferment/Climax/Decay) with day count
- Leader stock name + board count + today's status
- Limit-up count trend (last 3 days minimum)
- At least one decay warning signal assessment
- Historical duration reference for similar concept type
- Clear action recommendation (enter/hold/exit/avoid)

### Display Format

- Single concept analysis: stage diagram + leader + signals + recommendation
- Hot concept ranking: table (columns: concept / 5-day gain / stage / leader / limit-up count / recommendation)
- Always show the 4-stage lifecycle with current position marked
- Use directional language: "momentum building" / "peak approaching" / "fading fast"
