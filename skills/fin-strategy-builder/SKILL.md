---
name: fin-strategy-builder
description: "Strategy builder — turn natural language trading ideas into compliant FEP v1.1 strategy packages for Findoo Backtest (fep.yaml + scripts/strategy.py), with validation and L1/L2 routing."
metadata:
  {
    "openclaw":
      {
        "emoji": "🏗️",
        "requires":
          {
            "extensions":
              [
                "fin-core",
                "fin-market-data",
                "fin-data-bus",
                "fin-strategy-engine",
              ],
          },
      },
  }
---

# Strategy Builder (FEP v1.1)

Turn natural language trading ideas into **FEP v1.1** strategy packages compatible with the Findoo Backtest Agent. Generates `fep.yaml` + `scripts/strategy.py` (and optional `risk_manager.py`, `indicators.py`), validates against the spec, and chooses L1 (script) or L2 (agent) engine. Specification reference: **回测Server-fep-v1.1使用指南** (docs/finance/回测Server-fep-v1.1使用指南.md).

## Prerequisites (tool profile)

This skill needs **read** (read files) and **exec** (run shell commands). Ensure the agent has the **coding** tool profile: set `tools.profile: "coding"` or `tools.alsoAllow: ["read", "exec", "write", "edit"]`. See [Strategy builder tools config](https://docs.openclaw.ai/finance/strategy-builder-tools-config) for details. If the user reports "no read/exec tool", tell them to set `tools.profile` to `"coding"` in their OpenClaw config.

**No subagent required.** Do strategy creation in the **current session**: use read/write/edit to create `fep.yaml` and `scripts/strategy.py`, and exec for zip/validate. Do not use `sessions_spawn` for strategy building; the user may not have subagent permission.

## When to Use

**USE this skill when:**

- "help me create a strategy" / "build a strategy"
- "I want to DCA into BTC every week, buy more when it dips"
- "make me a trend following strategy for ETH"
- "generate a FEP strategy package" / "生成回测策略包"
- "I have a trading idea but don't know how to code it"
- "create a strategy for sideways crypto markets"
- "turn this idea into a backtest-ready package"
- "build a grid trading strategy for SOL"

## When NOT to Use

**DON'T use this skill when:**

- User wants to backtest an existing strategy — use fin-backtest or remote backtest tools
- User wants to evolve/mutate an existing strategy — use fin-strategy-evolution
- User wants research on which strategy type fits current market — use fin-strategy-research
- User wants to execute a live trade — use fin-trading
- User wants portfolio analysis — use fin-portfolio

## Tools

### Intent & Data Validation

- `fin_data_ohlcv` — Verify data availability for requested symbols
- `fin_data_regime` — Analyze current market regime (informs strategy design)
- `fin_market_price` — Check current prices and validate symbol existence

### Code Generation & Validation

- `fin_backtest_run` — Sanity check: quick backtest on 3-month data to verify generated code runs
- `fin_strategy_create` — Register the generated strategy in the platform

### Remote Backtest (fep v1.1, when fin-backtest-remote is enabled)

- `backtest_remote_validate` — Validate strategy package directory (fep v1.1) before zip/submit; **use first** when dir is ready
- `backtest_remote_submit` — Submit strategy ZIP to Findoo Backtest API (after validate + zip)
- `backtest_remote_status` / `backtest_remote_report` — Query task status and full report

### Supporting

- `fin_paper_create` — Deploy validated strategy to paper trading (optional follow-up)

---

## Strategy Package Structure (FEP v1.1)

**Required:**

```
<strategy-dir>/
├── fep.yaml           # 策略配置 (必需)
└── scripts/
    └── strategy.py    # 策略入口 (必需)，必须实现 compute(data)
```

**Optional:**

```
├── scripts/
│   ├── risk_manager.py   # 风控模块
│   └── indicators.py      # 自定义指标
└── data/                 # 自定义数据
```

**Packaging:** `cd <strategy-dir> && zip -r ../<name>.zip fep.yaml scripts/`

---

## fep.yaml (FEP v1.1)

### Minimal (L1 Script)

```yaml
fep: "1.1"

identity:
  id: fin-dca-basic-test          # 唯一标识 (必填)
  type: strategy                  # strategy | indicator | connector
  name: "DCA Basic Test Strategy"
  version: "1.0.0"

technical:
  language: python
  entryPoint: strategy.py         # scripts/ 下的入口文件

backtest:
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
  benchmark: BTC-USD
```

### Identity (optional v1.1 fields)

- `style`: trend | mean_reversion | dca | momentum | swing | hybrid
- `visibility`: public | private | unlisted
- `summary`, `description` (Markdown), `license`, `changelog`, `author`, `createdAt`, `updatedAt`
- `tags`: **string array** (YAML list)，例如：`tags: [dca, btc, adaptive, crypto]`  
  （不要生成 `tags: "dca, btc, adaptive, crypto"` 这种单一字符串，必须是字符串数组）

### Classification (optional)

- `market`: Crypto | US | CN | HK | Forex | Commodity
- `archetype`, `assetClasses`, `frequency`: hft | intraday | daily | weekly | monthly

### parameters (optional)

Array of `{ name, label, description, type, default, range: { min, max, step }, group }`.

### risk (optional)

- `riskLevel`: low | medium | high
- `maxPositionSizePct`, `maxDrawdownThreshold`, `stopLoss` (e.g. type: trailing, value: 15)

### L2 Agent (optional)

Only when engine is agent:

```yaml
agent:
  engine: agent
  mode: hybrid    # script | sample | hybrid | full | research
  budgetCapUsd: 5.0
```

### evolution (optional)

Knowledge-graph lineage: `originId`, `parentId`, `genes`, `lineage`.

---

## scripts/strategy.py — Mandatory Contract

**Must** implement a single entry function:

```python
def compute(data):
    """
    Args:
        data: pandas DataFrame, 包含 OHLCV 列 (open, high, low, close, volume)
    Returns:
        dict: {"action": "buy"|"sell"|"hold", "amount": float, "price": float, "reason": str}
    """
    close = data["close"].values
    current_price = float(close[-1])
    return {
        "action": "buy",
        "amount": 100.0,
        "price": current_price,
        "reason": f"Buy at ${current_price:.2f}",
    }
```

- **Allowed imports:** `numpy`, `pandas`, `math`, `statistics`, `datetime`, `collections`
- **Forbidden (server will reject):** `import os`, `import subprocess`, `import socket`, `eval()`, `exec()`, `open()`, `requests`, `urllib`, `__import__()`, `importlib`

---

## Builder Pipeline

### Step 1: Intent Collection (Conversational)

Extract key dimensions:

| Dimension | Example |
|-----------|---------|
| Asset | BTC, ETH, AAPL, 沪深300 |
| Frequency | daily, weekly, monthly |
| Core idea | buy dips, trend follow, grid, DCA |
| Capital | $10,000 |
| Risk tolerance | 25% max drawdown |
| Time horizon | 2024-01-01 to 2024-12-31 |
| Market | Crypto, US, CN, HK |

Ask clarifying questions if the idea is vague (e.g. "buy when cheap" → RSI oversold? below MA? fixed schedule?).

### Step 2: Technical Design (Propose & Confirm)

Propose: strategy archetype (DCA, trend, mean-reversion, momentum, grid), indicators (RSI, EMA, MACD, etc.), entry/exit logic, position sizing, risk controls, market adaptations. **Wait for user confirmation** before generating code.

### Step 3: Code Generation (FEP v1.1)

Generate:

1. **fep.yaml** — `fep: "1.1"`, identity (id, type, name, version; add style, market, riskLevel, parameters as needed), technical (language, entryPoint), backtest (defaultPeriod, initialCapital, benchmark)。  
   - 生成 `backtest.defaultPeriod` 时，**默认使用当前日期作为 `endDate`**（格式 `YYYY-MM-DD`，可用「今天」的日期），`startDate` 根据用户描述选择合理区间（例如最近 6–12 个月），不要总是写死固定年份。
2. **scripts/strategy.py** — Must define `compute(data)` returning `{"action", "amount", "price", "reason"}`. Use only allowed imports; no os/subprocess/socket/eval/exec/open/requests/urllib/__import__/importlib.
3. **Optional:** scripts/indicators.py, scripts/risk_manager.py (if design needs them; entry contract remains `compute(data)` in strategy.py).

Present the package structure and wait for confirmation before validation.

### Step 4: Self-Validation

1. **Structure:** Required files exist: `fep.yaml`, `scripts/strategy.py`.
2. **fep.yaml:** Valid YAML, top-level key `fep` (e.g. "1.1"), `identity.id`/`type`/`name`/`version`, `technical.entryPoint`, `backtest.defaultPeriod`/`initialCapital`/`benchmark`.
3. **strategy.py:** Defines `compute(data)`; return dict has `action`, `amount`, `price`, `reason`; no forbidden imports.
4. If **fin-backtest-remote** is available: call `backtest_remote_validate` with the strategy directory path; if `valid: false`, fix `errors` and re-validate. Do not zip/submit until validation passes.
5. **Sanity run:** If local backtest is available (`fin_backtest_run`), run on a short period to confirm code executes.

Auto-fix and re-validate up to 3 iterations; if still failing, explain clearly to the user.

### Step 5: L1 vs L2 Routing

| Signal | L1 (script) | L2 (agent) |
|--------|-------------|------------|
| Decision logic | Fully deterministic rules | Requires judgment, context |
| Engine in fep/API | `engine: script` or omit | `engine: agent`, `agent.budgetCapUsd` |
| Cost | No LLM cost | LLM budget cap |

**Default: L1.** Only set L2 (agent section in fep.yaml, engine=agent on submit) when the user explicitly wants agent involvement or strategy benefits from LLM analysis.

### Step 6: Delivery & Optional Remote Backtest

Present the package and next steps:

- **Local/registration:** Run backtest (fin-backtest), deploy to paper (fin_paper_create), tweak parameters in fep.yaml.
- **Remote Findoo Backtest (fep v1.1):** If user wants to submit to the remote server: 1) Ensure directory is validated (`backtest_remote_validate`). 2) Zip: `zip -r ../<name>.zip fep.yaml scripts/`. 3) Submit with `backtest_remote_submit` (filePath, optional symbol, initial_capital, start_date, end_date, engine, budget_cap_usd). 4) Poll with `backtest_remote_status`, fetch report with `backtest_remote_report` when status is completed.

---

## Strategy Template Library

| Template | style | market | Default engine |
|----------|-------|--------|----------------|
| Simple DCA | dca | Crypto | L1 (script) |
| Adaptive DCA | dca | Crypto | L1 |
| EMA Crossover | trend | Crypto | L1 |
| RSI Bounce | mean_reversion | Crypto | L1 |
| MACD Momentum | momentum | Crypto | L1 |
| Grid Trading | hybrid | Crypto | L1 |
| Multi-Factor | hybrid | Crypto | L2 (agent) |
| Regime Adaptive | hybrid | Crypto | L2 |

---

## Market Adaptation Rules

| Market | Fee / Settlement | Lot / Limits | Special |
|--------|------------------|--------------|---------|
| Crypto | ~0.1%, T+0 | 0.001+ | 24/7 |
| US Stock | ~0.1%, T+0 | 1 share | Pre/post hours |
| A-Share (CN) | ~0.154%, **T+1** | **100 shares** | **±10%/±20%**, stamp tax sell-only |
| HK | ~0.24%, T+0/T+2 | Variable | Lunch break |

For A-shares: T+1 signal delay, lot rounding to 100, price limit filters.

---

## Response Guidelines

- Understand the user's idea; ask questions if vague.
- Present technical design in plain language and wait for confirmation before code.
- After generation, show package structure (fep.yaml + scripts/strategy.py).
- Run validation and report pass/fail; use `backtest_remote_validate` when available before any remote submit.
- Prefer L1 when sufficient; suggest L2 only when needed.
- End with clear next steps (backtest, paper, remote submit, or iterate).

## Risk Disclosures

> Generated strategies are based on historical patterns and user ideas. They require backtesting and paper trading before real capital. The builder produces code from rules and does not guarantee profitability. Validate with backtest and paper trading before going live.
