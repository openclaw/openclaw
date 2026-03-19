---
name: strategy-builder
description: "Strategy builder — turn natural language trading ideas into compliant FEP v2.0 strategy packages for Findoo Backtest (fep.yaml + scripts/strategy.py), with validation and L1/L2 routing."
metadata:
  openclaw:
    emoji: "🏗️"
    requires:
      extensions: ["findoo-trader-plugin", "findoo-datahub-plugin"]
---

# Strategy Builder (FEP v2.0)

Turn natural language trading ideas into **FEP v2.0** strategy packages compatible with the Findoo Backtest Agent. Generates `fep.yaml` + `scripts/strategy.py` (and optional `risk_manager.py`, `indicators.py`), validates against the spec, and chooses L1 (script) or L2 (agent) engine. Specification reference: **FEP v2.0 协议说明** (docs/finance/FEP-v2.0-协议说明.md).

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

### Remote Backtest (fep v2.0, when fin-backtest-remote is enabled)

- `backtest_remote_validate` — Validate strategy package directory (fep v2.0) before zip/submit; **use first** when dir is ready
- `backtest_remote_submit` — Submit strategy ZIP to Findoo Backtest API (after validate + zip)
- `backtest_remote_status` / `backtest_remote_report` — Query task status and full report

### Supporting

- `fin_paper_create` — Deploy validated strategy to paper trading (optional follow-up)

---

## Strategy Package Structure (FEP v2.0)

**Required:**

```
<strategy-dir>/
├── fep.yaml           # 策略配置 (必需)
├── scripts/
│   └── strategy.py    # 策略入口 (必需)，必须实现 compute(data) 或 select(universe)
└── .created-meta.json # 本地元数据 (必需，用于跟踪本地创建的策略)
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

## fep.yaml (FEP v2.0)

### Minimal (L1 Script)

```yaml
fep: "2.0"

# ── 身份标识 (必填) ───────────────────────────────────────
identity:
  id: fin-dca-basic-test # 必填：策略唯一标识（英文 + 连字符）
  type: strategy # strategy | indicator | connector（默认 strategy）
  name: "DCA Basic Test Strategy" # 必填：策略显示名称
  version: "1.0.0" # 必填：语义化版本号
  style: dca # 必填：trend | mean-reversion | momentum | value | growth | breakout | rotation | hybrid
  visibility: public # 必填：public | private | unlisted
  summary: "Simple DCA strategy for BTC" # 必填：一句话策略描述
  description: "A simple DCA strategy that buys BTC periodically" # 必填：详细策略描述
  license: MIT # 必填：MIT | CC-BY-4.0 | proprietary
  tags: [dca, btc, crypto] # 必填：标签数组
  author:
    name: "OpenFinClaw" # 必填：作者名
    wallet: "0x..." # 可选：收益分配地址
  changelog:
    - version: "1.0.0"
      date: "2025-01-01"
      changes: "Initial release"

# ── 技术配置 (可选，有默认值) ───────────────────────────────
technical:
  language: python # 默认 python
  entryPoint: strategy.py # 默认 strategy.py

# ── 策略参数 (可选) ───────────────────────────────────────
parameters:
  - name: base_amount
    default: 100
    type: number
    label: "基础定投金额"
    range: { min: 10, max: 10000 }

# ── 回测配置 (必填) ───────────────────────────────────────
backtest:
  symbol: "BTC/USDT" # 必填：交易品种（服务端自动推断市场、货币、手续费）
  timeframe: 1d # 可选：1m | 5m | 15m | 30m | 1h | 4h | 1d | 1w（默认 1d）
  defaultPeriod:
    startDate: "2025-01-01"
    endDate: "2026-01-01"
  initialCapital: 10000 # 必填：初始资金

# ── 风控配置 (可选) ───────────────────────────────────────
risk:
  maxDrawdownThreshold: 25 # 最大回撤限制 (%)
  dailyLossLimitPct: 5 # 日亏损限制 (%)
  maxTradesPerDay: 10 # 日最大交易笔数

# ── 分类 (必填) ───────────────────────────────────────
classification:
  archetype: systematic # 必填: systematic | discretionary | hybrid
  market: Crypto # 必填: Crypto | US | CN | HK | Forex | Commodity
  assetClasses: [crypto] # 必填: 资产类别数组
  frequency: daily # 必填: daily | weekly | monthly
  riskProfile: medium # 必填: low | medium | high
```

### Version Increment Rule

**When the same strategy `id` is modified, increment `identity.version`:**

- Semver format `X.Y.Z`: increment `Z` (patch) for minor changes, `Y` for new features, `X` for breaking changes
- Example: `1.0.0` → `1.0.1` (parameter tweak), `1.1.0` (new indicator), `2.0.0` (logic redesign)
- If strategy `id` already exists in the registry, always bump version before saving/zipping

### Identity Fields (FEP v2.0)

**必填字段：**

- `id`: 策略唯一标识（英文 + 连字符，例如 `fin-dca-basic-test`）
- `type`: `strategy` | `indicator` | `connector`（默认 `strategy`）
- `name`: 策略显示名称
- `version`: 语义化版本号（例如 `"1.0.0"`）
- `style`: `trend` | `mean-reversion` | `momentum` | `value` | `growth` | `breakout` | `rotation` | `hybrid`
- `visibility`: `public` | `private` | `unlisted`
- `summary`: 一句话策略描述
- `description`: 详细策略说明（支持 Markdown）
- `license`: `MIT` | `CC-BY-4.0` | `proprietary`
- `tags`: **字符串数组**，必须使用**行内数组格式**：`tags: [dca, btc, adaptive, crypto]`
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
      date: "2026-01-01"
      changes: "Initial release"
  ```

**可选字段：**

- `createdAt`: `"2025-01-01"` (YYYY-MM-DD)
- `updatedAt`: `"2025-06-01"` (YYYY-MM-DD)

### Backtest Fields (FEP v2.0)

**必填字段：**

- `symbol`: 交易品种（服务端根据 symbol 自动推断市场类型、数据源、货币、手续费和结算规则）
- `defaultPeriod.startDate`: 回测开始日期
- `defaultPeriod.endDate`: 回测结束日期
- `initialCapital`: 初始资金

**可选字段：**

- `timeframe`: K线周期，`1m` | `5m` | `15m` | `30m` | `1h` | `4h` | `1d` | `1w`（默认 `1d`）
- `universe`: 多标的配置（轮动策略用）
  ```yaml
  universe:
    symbols: ["000001.SZ", "000002.SZ", "600519.SH"]
  ```
- `rebalance`: 再平衡配置（多标的用）
  ```yaml
  rebalance:
    frequency: monthly # daily | weekly | monthly
    maxHoldings: 2 # 最大同时持仓数
    weightMethod: equal # equal | market_cap
  ```

**服务端自动推断（用户无需指定）：**

| 配置项   | 推断规则                                                                          |
| -------- | --------------------------------------------------------------------------------- |
| 市场类型 | `000001.SZ` → A股, `AAPL` → 美股, `BTC/USDT` → Crypto, `00700.HK` → 港股          |
| 数据源   | 可识别 symbol → DataHub 真实数据, 未知 → 合成数据                                 |
| 货币     | A股 → CNY, 美股 → USD, 港股 → HKD, Crypto → USDT                                  |
| 手续费   | A股: 佣金+印花税+过户费, 港股: 佣金+印花税+征费, 美股: 零佣金, Crypto: MakerTaker |
| 结算规则 | A股/ETF → T+1, 其余 → T+0                                                         |

### Symbol 格式

| 格式               | 市场   | 示例                     |
| ------------------ | ------ | ------------------------ |
| `XXX/YYY`          | Crypto | `BTC/USDT`, `ETH/BTC`    |
| `6位数.SZ/SH`      | A股    | `000001.SZ`, `600519.SH` |
| `5位数.SH` (5开头) | ETF    | `510300.SH`              |
| `000xxx.SH`        | 指数   | `000300.SH`              |
| `4-5位数.HK`       | 港股   | `00700.HK`               |
| `1-5大写字母`      | 美股   | `AAPL`, `NVDA`           |
| `字母+数字.交易所` | 期货   | `IF2503.CFX`             |

### Classification (必填)

```yaml
classification:
  archetype: systematic # 必填: systematic | discretionary | hybrid
  market: Crypto # 必填: Crypto | US | CN | HK | Forex | Commodity
  assetClasses: [crypto] # 必填: 资产类别数组
  frequency: daily # 必填: daily | weekly | monthly
  riskProfile: medium # 必填: low | medium | high
```

### Risk (可选)

```yaml
risk:
  maxDrawdownThreshold: 25 # 最大回撤限制 (%)，默认 25
  dailyLossLimitPct: 5 # 日亏损限制 (%)，默认 5
  maxTradesPerDay: 10 # 日最大交易笔数，默认 10
```

### Paper (可选)

```yaml
paper:
  barIntervalSeconds: 60 # 行情轮询间隔（秒），默认 60
  maxDurationHours: 24 # 最大运行时长，默认 24
  warmupBars: 100 # 预热 K 线数，默认 100
  timeframe: 1d # 模拟盘 K 线周期
```

---

## scripts/strategy.py — Mandatory Contract

### 单标的策略：compute() 函数

**Must** implement a single entry function:

```python
# 模式 A: 无 context（简单策略）
def compute(data):
    """
    Args:
        data: pandas DataFrame, 包含 OHLCV 列 (open, high, low, close, volume)
    Returns:
        dict: {"action": "buy"|"sell"|"hold"|"target", ...}
    """
    close = data["close"].values
    current_price = float(close[-1])
    return {
        "action": "buy",
        "amount": 100.0,
        "price": current_price,
        "reason": f"Buy at ${current_price:.2f}",
    }

# 模式 B: 带 context（推荐，可获取仓位和资金信息）
def compute(data, context=None):
    """
    Args:
        data: pandas DataFrame
        context: dict with equity, cash, position, bar_index
    """
    position = context.get("position") if context else None
    # ...
```

**context 结构：**

```python
{
    "equity": 95000.0,           # 当前账户净值
    "cash": 45000.0,             # 可用现金
    "initial_capital": 100000.0, # 初始资金
    "position": {                # 有持仓时
        "side": "long",
        "quantity": 100.0,
        "market_value": 50000.0
    } or None,                   # 无持仓时
    "bar_index": 150             # 全局 K 线索引
}
```

**信号返回格式：**

| action   | 必填字段                   | 可选字段                  | 说明                          |
| -------- | -------------------------- | ------------------------- | ----------------------------- |
| `buy`    | amount, price              | reason                    | 按金额买入                    |
| `sell`   | —                          | percent, quantity, reason | 无参数=全仓卖, percent=按比例 |
| `hold`   | —                          | reason                    | 不操作                        |
| `target` | target_pct 或 target_value | reason                    | 调仓到目标权重/金额           |

### 多标的策略：select() 函数

用于轮动/选股策略，需在 backtest 中配置 universe：

```python
def select(universe):
    """
    Args:
        universe: dict[str, pd.DataFrame] - {symbol: DataFrame}
    Returns:
        list[str]: 选中标的列表（按优先级排序）
    """
    scores = []
    for symbol, df in universe.items():
        close = df["close"].values
        if len(close) < 20:
            continue
        momentum = (close[-1] / close[-20]) - 1
        scores.append((symbol, momentum))

    scores.sort(key=lambda x: x[1], reverse=True)
    return [s[0] for s in scores]  # 引擎自动截取 maxHoldings 个
```

- **Allowed imports:** `numpy`, `pandas`, `math`, `statistics`, `datetime`, `collections`, `ta`
- **Forbidden (server will reject):** `import os/subprocess/sys/socket/shutil/ctypes/importlib/signal/threading/multiprocessing/pathlib/tempfile/requests/urllib/http/ftplib/smtplib/xmlrpc/pickle/shelve/marshal/concurrent/asyncio/io`, `eval()`, `exec()`, `compile()`, `open()`, `__import__()`, `getattr()`, `setattr()`, `delattr()`, `vars()`, `dir()`, `breakpoint()`, `exit()`, `quit()`, `input()`, `globals()`, `locals()`
- **Forbidden (breaks backtest):** `datetime.now()`, `date.today()`

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
| Time horizon   | 2024-01-01 to 2024-12-31          |
| Market         | Crypto, US, CN, HK                |

Ask clarifying questions if the idea is vague (e.g. "buy when cheap" → RSI oversold? below MA? fixed schedule?).

### Step 2: Technical Design (Propose & Confirm)

Propose: strategy archetype (DCA, trend, mean-reversion, momentum, grid), indicators (RSI, EMA, MACD, etc.), entry/exit logic, position sizing, risk controls, market adaptations. **Wait for user confirmation** before generating code.

### Step 2.5: Determine Target Directory

**All locally created strategies MUST be saved to the standard path:**

```
~/.openfinclaw/workspace/strategies/{YYYY-MM-DD}/{slugified-name}/
```

**Path rules:**

- `{YYYY-MM-DD}`: Current date (e.g., `2026-03-19`), organizes strategies by creation date
- `{slugified-name}`: Lowercase, spaces/underscores to hyphens, max 40 chars (e.g., `btc-adaptive-dca`)
- **ALWAYS** create the date directory if it does not exist
- **NEVER** save strategies to arbitrary directories like `~/clawd`, `~/projects`, etc.

**Directory creation sequence:**

1. Compute `dateStr = formatDate(new Date())` → `"YYYY-MM-DD"`
2. Compute `slug = slugifyName(strategyName)` → lowercase-hyphenated
3. `rootDir = path.join(homedir(), ".openfinclaw", "workspace", "strategies")`
4. `dateDir = path.join(rootDir, dateStr)` — create if not exists
5. `targetDir = path.join(dateDir, slug)` — final strategy directory

**Example:**

```
Strategy name: "BTC Adaptive DCA"
Date: 2026-03-19
Target dir: ~/.openfinclaw/workspace/strategies/2026-03-19/btc-adaptive-dca/
```

**Metadata file (.created-meta.json):** After creating the strategy files, also generate this metadata file in the strategy directory:

```json
{
  "name": "fin-btc-adaptive-dca",
  "displayName": "BTC Adaptive DCA",
  "createdAt": "2026-03-19T10:30:00.000Z",
  "version": "1.0.0"
}
```

### Step 3: Code Generation (FEP v2.0)

Generate:

1. **fep.yaml** — `fep: "2.0"`, 包含以下部分：
   - **identity** (必填): id, type, name, version, style, visibility, summary, description, license, tags, author (对象格式，必须包含 name), changelog (至少一条记录)
   - **technical** (可选): language, entryPoint
   - **parameters** (可选): 策略参数数组
   - **backtest** (必填): symbol, defaultPeriod, initialCapital; 可选 timeframe, universe, rebalance
   - **classification** (必填): archetype, market, assetClasses, frequency, riskProfile
   - **risk** (可选): 风控配置

   **生成规则：**
   - `fep` 版本必须是 `"2.0"`
   - `backtest.defaultPeriod.endDate` 默认使用当前日期（格式 `YYYY-MM-DD`）
   - `backtest.defaultPeriod.startDate` 根据用户描述选择合理区间（例如最近 6–12 个月）
   - `backtest.symbol` 必填，服务端自动推断市场和手续费
   - **classification 必填字段及默认值：**
     - `archetype`: 默认 `systematic`（除非用户明确需要主观判断）
     - `market`: 根据标的自动推断（BTC/ETH → `Crypto`，AAPL → `US` 等）
     - `assetClasses`: 根据标的自动推断（BTC/ETH → `[crypto]`，AAPL → `[equity]`）
     - `frequency`: 默认 `daily`（日频）
     - `riskProfile`: 默认 `medium`
   - **版本递增规则：** 如果策略 `id` 已存在（用户修改现有策略），必须递增 `identity.version`
   - **默认作者：** `identity.author.name` 默认为 `"OpenFinClaw"`，除非用户指定其他作者
   - **默认可见性：** `identity.visibility` 默认为 `"public"`（公开策略）
   - **默认许可证：** `identity.license` 默认为 `"MIT"`
   - **默认风格：** `identity.style` 根据策略类型自动选择
   - **tags 格式：** 必须使用行内数组 `tags: [dca, btc, crypto]`

2. **scripts/strategy.py** — Must define `compute(data)` or `compute(data, context=None)` returning signal dict, or `select(universe)` for multi-asset strategies. Use only allowed imports; no forbidden patterns.

3. **.created-meta.json** — Metadata file for local strategy tracking (required for all locally created strategies):

   ```json
   {
     "name": "fin-btc-adaptive-dca",
     "displayName": "BTC Adaptive DCA",
     "createdAt": "2026-03-19T10:30:00.000Z",
     "version": "1.0.0"
   }
   ```

4. **Optional:** scripts/indicators.py, scripts/risk_manager.py (if design needs them; entry contract remains `compute(data)` in strategy.py).

Present the package structure and wait for confirmation before validation.

### Step 4: Self-Validation

1. **Structure:** Required files exist: `fep.yaml`, `scripts/strategy.py`, `.created-meta.json`.
2. **fep.yaml:**
   - Valid YAML, top-level key `fep: "2.0"`
   - `identity`: id, name, type, version, style, visibility, summary, description, license, tags, author.name, changelog (全部必填)
   - `backtest`: symbol, defaultPeriod (startDate/endDate), initialCapital (全部必填)
   - `classification`: archetype, market, assetClasses, frequency, riskProfile (全部必填)
3. **strategy.py:** Defines `compute(data)` or `select(universe)`; return dict has required fields; no forbidden imports/calls.
4. **.created-meta.json:** Valid JSON with `name`, `displayName`, `createdAt`, `version` fields.
5. **Target directory:** Must be under `~/.openfinclaw/workspace/strategies/{YYYY-MM-DD}/`.
6. If **fin-backtest-remote** is available: call `backtest_remote_validate` with the strategy directory path; if `valid: false`, fix `errors` and re-validate. Do not zip/submit until validation passes.
7. **Sanity run:** If local backtest is available (`fin_backtest_run`), run on a short period to confirm code executes.

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
- **Remote Findoo Backtest (fep v2.0):** If user wants to submit to the remote server:
  1. Ensure directory is validated (`backtest_remote_validate`)
  2. Zip: `zip -r ../<id>-<version>.zip fep.yaml scripts/` (e.g. `fin-dca-basic-test-1.0.0.zip`)
  3. Submit with `backtest_remote_submit` (filePath, optional engine, budget_cap_usd)
  4. Poll with `backtest_remote_status`, fetch report with `backtest_remote_report` when status is completed

---

## Strategy Template Library

| Template             | style          | market | Entry Function |
| -------------------- | -------------- | ------ | -------------- |
| Simple DCA           | dca            | Crypto | compute()      |
| Adaptive DCA         | dca            | Crypto | compute()      |
| EMA Crossover        | trend          | Crypto | compute()      |
| RSI Bounce           | mean-reversion | Crypto | compute()      |
| MACD Momentum        | momentum       | Crypto | compute()      |
| Grid Trading         | hybrid         | Crypto | compute()      |
| Multi-Asset Rotation | rotation       | CN     | select()       |
| Multi-Factor         | hybrid         | Crypto | compute()      |

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
