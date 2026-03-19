---
name: strategy-pack
description: "Create and validate Findoo Backtest (FEP v2.0) strategy packages. Use when the user wants to create a strategy pack, generate fep.yaml and strategy.py, or prepare a folder for remote backtest. Always validate with backtest_remote_validate before zipping and submitting."
metadata: { "openclaw": { "requires": { "extensions": ["fin-backtest-remote"] } } }
---

# 策略包生成与校验 (FEP v2.0)

当用户要**创建策略包**、**生成回测策略包**、**写 fep 策略**、**打包后提交回测**时，按以下结构生成目录和文件，并在**上传前必须用 `backtest_remote_validate` 校验**，通过后再打包为 ZIP 并提交。

## 何时触发

- 用户说：创建策略包、生成策略包、写一个 fep 策略、帮我打包成回测包、准备提交回测
- 用户要：按回测服务器要求生成目录结构、写 fep.yaml 和 strategy.py

## 策略包目录结构（必选 + 可选）

```
<strategy-dir>/
├── fep.yaml              # 必需：策略元数据与回测配置
└── scripts/
    └── strategy.py       # 必需：策略入口，必须实现 compute(data) 或 select(universe)
    ├── risk_manager.py   # 可选
    └── indicators.py     # 可选
└── data/                 # 可选：自定义数据
```

## fep.yaml 配置 (FEP v2.0)

### 最小配置 (L1 Script)

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
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000 # 必填：初始资金

# ── 风控配置 (可选) ───────────────────────────────────────
risk:
  maxDrawdownThreshold: 25 # 最大回撤限制 (%)，默认 25
  dailyLossLimitPct: 5 # 日亏损限制 (%)，默认 5
  maxTradesPerDay: 10 # 日最大交易笔数，默认 10

# ── 分类 (可选，展示用) ───────────────────────────────────────
classification:
  archetype: systematic # systematic | discretionary | hybrid
  market: Crypto # Crypto | US | CN | HK | Forex | Commodity
  assetClasses: [crypto]
  frequency: daily # daily | weekly | monthly
  riskProfile: medium # low | medium | high
```

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
      date: "2025-01-01"
      changes: "Initial release"
  ```

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

### Classification (可选)

```yaml
classification:
  archetype: systematic # systematic | discretionary | hybrid
  market: Crypto # Crypto | US | CN | HK | Forex | Commodity
  assetClasses: [crypto]
  frequency: weekly # daily | weekly | monthly
  riskProfile: medium # low | medium | high
```

### Risk (可选)

```yaml
risk:
  maxDrawdownThreshold: 25 # 最大回撤限制 (%)，默认 25
  dailyLossLimitPct: 5 # 日亏损限制 (%)，默认 5
  maxTradesPerDay: 10 # 日最大交易笔数，默认 10
```

## scripts/strategy.py 要求

### 单标的策略：compute() 函数

```python
# 模式 A: 无 context（简单策略）
def compute(data):
    """
    Args:
        data: pandas DataFrame，含列 open, high, low, close, volume
    Returns:
        dict: 键至少包含 action ("buy"|"sell"|"hold"|"target")
    """
    close = data["close"].values
    current_price = float(close[-1])
    return {
        "action": "buy",
        "amount": 100.0,
        "price": current_price,
        "reason": f"Buy at ${current_price:.2f}",
    }

# 模式 B: 带 context（推荐）
def compute(data, context=None):
    """
    Args:
        data: pandas DataFrame
        context: dict with equity, cash, position, bar_index
    """
    position = context.get("position") if context else None
    # ...
```

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
    return [s[0] for s in scores]
```

- **允许的导入**：`numpy`, `pandas`, `math`, `statistics`, `datetime`, `collections`, `ta`
- **禁止（服务器会拒绝）**：
  - Import: `os/subprocess/sys/socket/shutil/ctypes/importlib/signal/threading/multiprocessing/pathlib/tempfile/requests/urllib/http/ftplib/smtplib/xmlrpc/pickle/shelve/marshal/concurrent/asyncio/io`
  - 调用: `eval()`, `exec()`, `compile()`, `open()`, `__import__()`, `getattr()`, `setattr()`, `delattr()`, `vars()`, `dir()`, `breakpoint()`, `exit()`, `quit()`, `input()`, `globals()`, `locals()`
  - 破坏回测: `datetime.now()`, `date.today()`

## 上传前校验与提交流程

### Step 1: 生成或编辑策略包

生成策略包目录（fep.yaml + scripts/strategy.py）。

### Step 2: Self-Validation (自我校验)

1. **Structure:** 必需文件存在：`fep.yaml`, `scripts/strategy.py`。
2. **fep.yaml:**
   - Valid YAML, top-level key `fep: "2.0"`
   - `identity`: id, name, type, version, style, visibility, summary, description, license, tags, author.name, changelog (全部必填)
   - `backtest`: symbol, defaultPeriod (startDate/endDate), initialCapital (全部必填)
3. **strategy.py:** 定义 `compute(data)` 或 `select(universe)`；返回 dict 包含正确字段；无禁止的导入/调用。
4. 调用 `backtest_remote_validate` 传入策略包目录路径 `dirPath`。若返回 `valid: false`，根据 `errors` 修正后再次校验。
5. Auto-fix and re-validate up to 3 iterations；若仍失败，向用户清晰解释问题。

**不要**在校验未通过时打包上传。

### Step 3: 打包

校验通过后，在策略包目录下执行 `zip -r ../<id>-<version>.zip fep.yaml scripts/`（例如 `fin-dca-basic-test-1.0.0.zip`），得到 ZIP 路径。

### Step 4: 提交

调用 `backtest_remote_submit`，传入 ZIP 的 `filePath`（及可选 engine, budget_cap_usd）。

## 相关 Tools

| Tool                                                | 用途                                                    |
| --------------------------------------------------- | ------------------------------------------------------- |
| `backtest_remote_validate`                          | 校验策略包目录格式是否符合 fep v2.0，通过后才可打包上传 |
| `backtest_remote_submit`                            | 提交已打包的 ZIP 到远程回测服务                         |
| `backtest_remote_status` / `backtest_remote_report` | 查询任务状态与报告                                      |

总结：**先按本 skill 生成/补全策略包 → 用 backtest_remote_validate 校验 → 通过后再打包并 backtest_remote_submit**。
