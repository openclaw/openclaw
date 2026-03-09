---
name: strategy-pack
description: "Create and validate Findoo Backtest (fep v1.2) strategy packages. Use when the user wants to create a strategy pack, generate fep.yaml and strategy.py, or prepare a folder for remote backtest. Always validate with backtest_remote_validate before zipping and submitting."
metadata: { "openclaw": { "requires": { "extensions": ["fin-backtest-remote"] } } }
---

# 策略包生成与校验 (FEP v1.2)

当用户要**创建策略包**、**生成回测策略包**、**写 fep 策略**、**打包后提交回测**时，按以下结构生成目录和文件，并在**上传前必须用 `backtest_remote_validate` 校验**，通过后再打包为 ZIP 并提交。

## 何时触发

- 用户说：创建策略包、生成策略包、写一个 fep 策略、帮我打包成回测包、准备提交回测
- 用户要：按回测服务器要求生成目录结构、写 fep.yaml 和 strategy.py

## 策略包目录结构（必选 + 可选）

```
<strategy-dir>/
├── fep.yaml              # 必需：策略元数据与回测配置
└── scripts/
    └── strategy.py       # 必需：策略入口，必须实现 compute(data)
    ├── risk_manager.py   # 可选
    └── indicators.py     # 可选
└── data/                 # 可选：自定义数据
```

## fep.yaml 配置 (FEP v1.2)

### 最小配置 (L1 Script)

```yaml
fep: "1.2"

# ── 身份标识 (必填) ───────────────────────────────────────
identity:
  id: fin-my-strategy-01 # 必填：策略唯一标识（英文 + 连字符）
  type: strategy # strategy | indicator | connector
  name: "My Strategy" # 策略显示名称
  version: "1.0.0" # 语义化版本号
  style: dca # trend | mean_reversion | dca | momentum | swing | hybrid
  author:
    name: "OpenFinClaw" # 默认作者名
  summary: "Simple DCA strategy"

# ── 技术配置 (必填) ───────────────────────────────────────
technical:
  language: python
  entryPoint: strategy.py # scripts/ 下的入口文件

# ── 回测配置 (必填) ───────────────────────────────────────
backtest:
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  frequencyDays: 1 # 回测频率（天）
  initialCapital: 10000 # 初始资金 (USD)
  currency: USD # 货币类型
  benchmark: BTC-USD # 基准标的
  commissionRate: 0.001 # 手续费率 0.1%
  slippageRate: 0.0005 # 滑点率 0.05%
  dataSource: synthetic # synthetic | datahub | csv
```

### Identity 字段说明

**必填字段：**

- `id`: 策略唯一标识（英文 + 连字符，例如 `fin-dca-basic-test`）
- `type`: `strategy` | `indicator` | `connector`
- `name`: 策略显示名称
- `version`: 语义化版本号（例如 `"1.0.0"`）

**可选字段：**

- `style`: `trend` | `mean_reversion` | `dca` | `momentum` | `swing` | `hybrid`
- `visibility`: `public` | `private` | `unlisted`
- `summary`: 一句话策略描述
- `description`: 详细策略说明（支持 Markdown）
- `tags`: **字符串数组**，必须使用**行内数组格式**：`tags: [dca, btc, adaptive, crypto]`
- `license`: `MIT` | `CC-BY-4.0` | `proprietary`
- `author`: 对象格式
  ```yaml
  author:
    name: "OpenFinClaw"
    wallet: "0x..." # 可选：收益分配地址
  ```
- `createdAt`: `"2024-01-01"` (YYYY-MM-DD)
- `updatedAt`: `"2024-06-01"` (YYYY-MM-DD)
- `changelog`: 变更日志数组
  ```yaml
  changelog:
    - version: "1.0.0"
      date: "2024-01-01"
      changes: "Initial release"
  ```

### Classification (可选)

```yaml
classification:
  archetype: systematic # systematic | discretionary | hybrid
  market: Crypto # Crypto | US | CN | HK | Forex | Commodity
  assetClasses: [crypto]
  frequency: weekly # daily | weekly | monthly
  riskProfile: medium # low | medium | high
```

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

## scripts/strategy.py 要求

- **必须**定义函数：`def compute(data):`
  - `data`: pandas DataFrame，含列 open, high, low, close, volume
  - 返回：`dict`，键至少包含 `action` ("buy"|"sell"|"hold")、`amount`、`price`、`reason`

示例：

```python
def compute(data):
    close = data["close"].values
    current_price = float(close[-1])
    return {
        "action": "buy",
        "amount": 100.0,
        "price": current_price,
        "reason": f"Buy at ${current_price:.2f}",
    }
```

- **允许的导入**：`numpy`, `pandas`, `math`, `statistics`, `datetime`, `collections`
- **禁止（服务器会拒绝）**：`import os/subprocess/socket`、`eval()`、`exec()`、`open()`、`requests`、`urllib`、`__import__()`、`importlib`

## 上传前校验与提交流程

1. **生成或编辑**策略包目录（fep.yaml + scripts/strategy.py）。
2. **校验**：调用 `backtest_remote_validate`，传入策略包目录路径 `dirPath`。若返回 `valid: false`，根据 `errors` 修正后再次校验，**不要**在未通过时打包上传。
3. **打包**：校验通过后，在策略包目录下执行 `zip -r ../<id>-<version>.zip fep.yaml scripts/`（例如 `fin-dca-basic-test-1.0.0.zip`），得到 ZIP 路径。
4. **提交**：调用 `backtest_remote_submit`，传入 ZIP 的 `filePath`（及可选 symbol、initial_capital、start_date、end_date、engine、budget_cap_usd）。

## 相关 Tools

| Tool                                                | 用途                                                    |
| --------------------------------------------------- | ------------------------------------------------------- |
| `backtest_remote_validate`                          | 校验策略包目录格式是否符合 fep v1.2，通过后才可打包上传 |
| `backtest_remote_submit`                            | 提交已打包的 ZIP 到远程回测服务                         |
| `backtest_remote_status` / `backtest_remote_report` | 查询任务状态与报告                                      |

总结：**先按本 skill 生成/补全策略包 → 用 backtest_remote_validate 校验 → 通过后再打包并 backtest_remote_submit**。
