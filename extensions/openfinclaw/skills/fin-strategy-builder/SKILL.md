---
name: fin-strategy-builder
description: "Strategy builder — turn natural language trading ideas into compliant FEP v1.2 strategy packages for Findoo Backtest (fep.yaml + scripts/strategy.py), with validation and L1/L2 routing."
metadata:
  {
    "openclaw":
      {
        "emoji": "🏗️",
        "requires":
          {
            "extensions":
              ["fin-core", "fin-market-data", "fin-shared-types", "fin-strategy-engine"],
          },
      },
  }
---

# Strategy Builder (FEP v1.2)

Turn natural language trading ideas into **FEP v1.2** strategy packages compatible with the Findoo Backtest Agent. Generates `fep.yaml` + `scripts/strategy.py` (and optional `risk_manager.py`, `indicators.py`), validates against the spec, and chooses L1 (script) or L2 (agent) engine. Specification reference: **FEP v1.2 Reference** (docs/finance/fep-v1.2-reference.yaml).

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

### Remote Backtest (fep v1.2, when fin-backtest-remote is enabled)

- `backtest_remote_validate` — Validate strategy package directory (fep v1.2) before zip/submit; **use first** when dir is ready
- `backtest_remote_submit` — Submit strategy ZIP to Findoo Backtest API (after validate + zip)
- `backtest_remote_status` / `backtest_remote_report` — Query task status and full report

### Supporting

- `fin_paper_create` — Deploy validated strategy to paper trading (optional follow-up)

---

## Strategy Package Structure (FEP v1.2)

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

**Packaging:** `cd <strategy-dir> && zip -r ../<id>-<version>.zip fep.yaml scripts/` (e.g. `fin-dca-basic-test-1.0.0.zip`)

---

## fep.yaml (FEP v1.2)

### Minimal (L1 Script)

```yaml
fep: "1.2"

# ── 身份标识 (必填) ───────────────────────────────────────
identity:
  id: fin-dca-basic-test # 必填：策略唯一标识（英文 + 连字符）
  type: strategy # strategy | indicator | connector
  name: "DCA Basic Test Strategy" # 策略显示名称
  version: "1.0.0" # 语义化版本号
  style: dca # trend | mean_reversion | dca | momentum | swing | hybrid
  visibility: public # public | private | unlisted（默认 public）
  license: MIT # MIT | CC-BY-4.0 | proprietary（默认 MIT）
  author:
    name: "OpenFinClaw" # 默认作者
    wallet: "0x..." # 可选：收益分配地址
  summary: "Simple DCA strategy for BTC"
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial release"

# ── 技术配置 (必填) ───────────────────────────────────────
technical:
  language: python
  entryPoint: strategy.py # scripts/ 下的入口文件

# ── 回测配置 (必填) ───────────────────────────────────────
backtest:
  defaultPeriod:
    startDate: "2025-01-01"
    endDate: "2025-12-31"
  frequencyDays: 1 # 回测频率（天）
  initialCapital: 10000 # 初始资金 (USD)
  currency: USD # 货币类型
  benchmark: BTC-USD # 基准标的
  commissionRate: 0.001 # 手续费率 0.1%
  slippageRate: 0.0005 # 滑点率 0.05%
  dataSource: synthetic # synthetic | datahub | csv

# ── 分类 (必填) ──────────────────────────────────────────
classification:
  archetype: systematic # systematic | discretionary | hybrid
  market: Crypto # Crypto | US | CN | HK | Forex | Commodity
  assetClasses: [crypto]
  frequency: daily # daily | weekly | monthly
  riskProfile: medium # low | medium | high
```

### Version Increment Rule

**When the same strategy `id` is modified, increment `identity.version`:**

- Semver format `X.Y.Z`: increment `Z` (patch) for minor changes, `Y` for new features, `X` for breaking changes
- Example: `1.0.0` → `1.0.1` (parameter tweak), `1.1.0` (new indicator), `2.0.0` (logic redesign)
- If strategy `id` already exists in the registry, always bump version before saving/zipping

### Identity Fields (FEP v1.2)

**必填字段：**

- `id`: 策略唯一标识（英文 + 连字符，例如 `fin-dca-basic-test`）
- `type`: `strategy` | `indicator` | `connector`
- `name`: 策略显示名称
- `version`: 语义化版本号（例如 `"1.0.0"`）
- `style`: `trend` | `mean_reversion` | `dca` | `momentum` | `swing` | `hybrid`
- `visibility`: `public` | `private` | `unlisted`（默认 `private`）
- `summary`: 一句话策略描述
- `license`: `MIT` | `CC-BY-4.0` | `proprietary`（默认 `MIT`）
- `author`: 对象格式（必须包含 `name`）
  ```yaml
  author:
    name: "OpenFinClaw" # 必填：作者名
    wallet: "0x..." # 可选：收益分配地址
  ```
- `changelog`: 变更日志数组（至少包含一条初始版本记录）
  ```yaml
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial release"
  ```

**可选字段：**

- `description`: 详细策略说明（支持 Markdown）
- `tags`: **字符串数组**，必须使用**行内数组格式**：`tags: [dca, btc, adaptive, crypto]`
- `createdAt`: `"2025-01-01"` (YYYY-MM-DD)
- `updatedAt`: `"2025-06-01"` (YYYY-MM-DD)

### Classification (必填)

```yaml
classification:
  archetype: systematic # systematic | discretionary | hybrid
  market: Crypto # Crypto | US | CN | HK | Forex | Commodity
  assetClasses: [crypto]
  frequency: weekly # daily | weekly | monthly
  riskProfile: medium # low | medium | high (fallback for risk.riskLevel)
```

**字段说明：**

| 字段           | 类型     | 必填 | 可选值                                                     | 说明                                   |
| -------------- | -------- | ---- | ---------------------------------------------------------- | -------------------------------------- |
| `archetype`    | string   | 是   | `systematic` \| `discretionary` \| `hybrid`                | 策略类型：系统化/主观/混合             |
| `market`       | string   | 是   | `Crypto` \| `US` \| `CN` \| `HK` \| `Forex` \| `Commodity` | 目标市场                               |
| `assetClasses` | string[] | 是   | `[crypto]`, `[equity]`, `[forex]`, `[commodity]`           | 资产类别数组                           |
| `frequency`    | string   | 是   | `daily` \| `weekly` \| `monthly`                           | 交易频率                               |
| `riskProfile`  | string   | 是   | `low` \| `medium` \| `high`                                | 风险等级（可被 `risk.riskLevel` 覆盖） |

### Parameters (可选)

```yaml
parameters:
  - name: base_amount
    default: 100
    type: number
    label: "基础定投金额"
    range: { min: 10, max: 10000, step: 10 }
  - name: sma_fast
    default: 20
    type: integer
    label: "快速均线周期"
    range: { min: 5, max: 50 }
  - name: sma_slow
    default: 50
    type: integer
    label: "慢速均线周期"
    range: { min: 20, max: 200 }
```

### Risk (可选但推荐)

```yaml
risk:
  riskLevel: medium # low | medium | high
  maxPositionSizePct: 100 # 单标的最大仓位 %
  maxExposurePct: 100 # 总敞口 %
  maxConcurrentPositions: 3 # 最大同时持仓数
  maxLeverage: 1.0 # 最大杠杆
  maxDrawdownThreshold: 25 # 最大回撤阈值 %
  stopLoss:
    type: trailing # fixed | trailing | atr-based
    value: 15 # 止损百分比或 ATR 倍数
```

### L2 Agent (仅 L2 策略需要)

```yaml
agent:
  engine: agent # 触发 L2 Agent 引擎
  mode: hybrid # script | sample | hybrid | full | research
  model: claude-sonnet-4-6-20250514
  budgetCapUsd: 5.0 # LLM 推理成本上限 (USD)
  maxTurnsPerPeriod: 10
  reflectionInterval: 20 # 每 N 周期执行一次反思
  drawdownAlertPct: 15.0 # 触发深度分析的回撤阈值
  priceSpikePct: 5.0 # 触发深度分析的价格波动阈值
```

### Evolution (可选)

```yaml
evolution:
  originId: "" # 策略谱系根节点 ID
  parentId: "" # 直接父策略 ID
  forkSource: "" # fork 来源 URL
```

### Integrity Proof (v1.2 新增，系统自动生成)

**用户无需手动编辑此节**。Fork 时系统自动写入 parentCID，回测完成后系统自动计算 contentHash/codeHash/fepHash。

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

| Dimension      | Example                           |
| -------------- | --------------------------------- |
| Asset          | BTC, ETH, AAPL, 沪深 300          |
| Frequency      | daily, weekly, monthly            |
| Core idea      | buy dips, trend follow, grid, DCA |
| Capital        | $10,000                           |
| Risk tolerance | 25% max drawdown                  |
| Time horizon   | 2025-01-01 to 2025-12-31          |
| Market         | Crypto, US, CN, HK                |

Ask clarifying questions if the idea is vague (e.g. "buy when cheap" → RSI oversold? below MA? fixed schedule?).

### Step 2: Technical Design (Propose & Confirm)

Propose: strategy archetype (DCA, trend, mean-reversion, momentum, grid), indicators (RSI, EMA, MACD, etc.), entry/exit logic, position sizing, risk controls, market adaptations. **Wait for user confirmation** before generating code.

### Step 3: Code Generation (FEP v1.2)

Generate:

1. **fep.yaml** — `fep: "1.2"`, 包含以下部分：
   - **identity** (必填): id, type, name, version, style, visibility, summary, license, author (对象格式，必须包含 name), changelog (至少一条记录)
   - **technical** (必填): language, entryPoint
   - **backtest** (必填): defaultPeriod, frequencyDays, initialCapital, currency, benchmark, commissionRate, slippageRate, dataSource
   - **classification** (必填): archetype, market, assetClasses, frequency, riskProfile
   - **parameters** (可选): 策略参数数组
   - **risk** (可选但推荐): 风控配置
   - **agent** (仅 L2): L2 Agent 配置
   - **evolution** (可选): 进化谱系

   **生成规则：**
   - `fep` 版本必须是 `"1.2"`
   - `backtest.defaultPeriod.endDate` 默认使用当前日期（格式 `YYYY-MM-DD`）
   - `backtest.defaultPeriod.startDate` 根据用户描述选择合理区间（例如最近 6–12 个月）
   - `backtest.frequencyDays` 默认 `1`（日频）
   - `backtest.currency` 默认 `"USD"`
   - `backtest.commissionRate` 默认 `0.001` (0.1%)
   - `backtest.slippageRate` 默认 `0.0005` (0.05%)
   - `backtest.dataSource` 默认 `"synthetic"`
   - **classification 默认值：**
     - `archetype`: 默认 `systematic`（除非用户明确需要主观判断）
     - `market`: 根据标的自动推断（BTC/ETH → `Crypto`，AAPL → `US` 等）
     - `assetClasses`: 根据标的自动推断（BTC/ETH → `[crypto]`，AAPL → `[equity]`）
     - `frequency`: 默认 `daily`（日频）
     - `riskProfile`: 默认 `medium`
   - **版本递增规则：** 如果策略 `id` 已存在（用户修改现有策略），必须递增 `identity.version`
     - Semver 格式 `X.Y.Z` 递增 `Z`（patch），双部分 `X.Y` 递增 `Y`，纯数字递增自身
     - 示例：`1.0.0` → `1.0.1`（参数调整），`1.1.0`（新指标），`2.0.0`（逻辑重构）
   - **默认作者：** `identity.author.name` 默认为 `"OpenFinClaw"`，除非用户指定其他作者
   - **默认可见性：** `identity.visibility` 默认为 `"public"`（公开策略）
   - **默认许可证：** `identity.license` 默认为 `"MIT"`
   - **默认风格：** `identity.style` 根据策略类型自动选择（DCA 策略用 `dca`，趋势跟踪用 `trend` 等）
   - **tags 格式：** 必须使用行内数组 `tags: [dca, btc, crypto]`，禁止多行列表或单一字符串
   - **changelog 位置：** `changelog` 必须放在 `identity` 节点下，不能放在根级别；初始版本必须包含至少一条记录

2. **scripts/strategy.py** — Must define `compute(data)` returning `{"action", "amount", "price", "reason"}`. Use only allowed imports; no os/subprocess/socket/eval/exec/open/requests/urllib/**import**/importlib.

3. **Optional:** scripts/indicators.py, scripts/risk_manager.py (if design needs them; entry contract remains `compute(data)` in strategy.py).

Present the package structure and wait for confirmation before validation.

### Step 4: Self-Validation

1. **Structure:** Required files exist: `fep.yaml`, `scripts/strategy.py`.
2. **fep.yaml:**
   - Valid YAML, top-level key `fep: "1.2"`
   - `identity`: id, type, name, version, style, visibility, summary, license (全部必填)
   - `identity.author`: name (必填), wallet (可选)
   - `identity.changelog`: 至少包含一条版本记录 (必填)
   - `classification`: archetype, market, assetClasses, frequency, riskProfile (全部必填)
   - `technical`: language, entryPoint (必填)
   - `backtest`: defaultPeriod (startDate/endDate), frequencyDays, initialCapital, currency, benchmark, commissionRate, slippageRate, dataSource (全部必填)
3. **strategy.py:** Defines `compute(data)`; return dict has `action`, `amount`, `price`, `reason`; no forbidden imports.
4. If **fin-backtest-remote** is available: call `backtest_remote_validate` with the strategy directory path; if `valid: false`, fix `errors` and re-validate. Do not zip/submit until validation passes.
5. **Sanity run:** If local backtest is available (`fin_backtest_run`), run on a short period to confirm code executes.

Auto-fix and re-validate up to 3 iterations; if still failing, explain clearly to the user.

### Step 5: L1 vs L2 Routing

| Signal            | L1 (script)               | L2 (agent)                            |
| ----------------- | ------------------------- | ------------------------------------- |
| Decision logic    | Fully deterministic rules | Requires judgment, context            |
| Engine in fep/API | `engine: script` or omit  | `engine: agent`, `agent.budgetCapUsd` |
| Cost              | No LLM cost               | LLM budget cap                        |

**Default: L1.** Only set L2 (agent section in fep.yaml, engine=agent on submit) when the user explicitly wants agent involvement or strategy benefits from LLM analysis.

### Step 6: Delivery & Optional Remote Backtest

Present the package and next steps:

- **Local/registration:** Run backtest (fin-backtest), deploy to paper (fin_paper_create), tweak parameters in fep.yaml.
- **Remote Findoo Backtest (fep v1.2):** If user wants to submit to the remote server:
  1. Ensure directory is validated (`backtest_remote_validate`)
  2. Zip: `zip -r ../<id>-<version>.zip fep.yaml scripts/` (e.g. `fin-dca-basic-test-1.0.0.zip`)
  3. Submit with `backtest_remote_submit` (filePath, optional symbol, initial_capital, start_date, end_date, engine, budget_cap_usd)
  4. Poll with `backtest_remote_status`, fetch report with `backtest_remote_report` when status is completed

---

## Strategy Template Library

| Template        | style          | market | Default engine |
| --------------- | -------------- | ------ | -------------- |
| Simple DCA      | dca            | Crypto | L1 (script)    |
| Adaptive DCA    | dca            | Crypto | L1             |
| EMA Crossover   | trend          | Crypto | L1             |
| RSI Bounce      | mean_reversion | Crypto | L1             |
| MACD Momentum   | momentum       | Crypto | L1             |
| Grid Trading    | hybrid         | Crypto | L1             |
| Multi-Factor    | hybrid         | Crypto | L2 (agent)     |
| Regime Adaptive | hybrid         | Crypto | L2             |

---

## Market Adaptation Rules

| Market       | Fee / Settlement | Lot / Limits   | Special                            |
| ------------ | ---------------- | -------------- | ---------------------------------- |
| Crypto       | ~0.1%, T+0       | 0.001+         | 24/7                               |
| US Stock     | ~0.1%, T+0       | 1 share        | Pre/post hours                     |
| A-Share (CN) | ~0.154%, **T+1** | **100 shares** | **±10%/±20%**, stamp tax sell-only |
| HK           | ~0.24%, T+0/T+2  | Variable       | Lunch break                        |

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
