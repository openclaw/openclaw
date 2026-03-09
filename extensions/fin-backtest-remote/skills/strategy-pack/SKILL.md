---
name: strategy-pack
description: "Create and validate Findoo Backtest (fep v1.1) strategy packages. Use when the user wants to create a strategy pack, generate fep.yaml and strategy.py, or prepare a folder for remote backtest. Always validate with backtest_remote_validate before zipping and submitting."
metadata: { "openclaw": { "requires": { "extensions": ["fin-backtest-remote"] } } }
---

# 策略包生成与校验 (fep v1.1)

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

## fep.yaml 最小配置 (L1 Script)

生成或补全时至少包含以下结构：

```yaml
fep: "1.1"

identity:
  id: <唯一标识，如 fin-my-strategy-01>
  type: strategy
  name: "<策略显示名称>"
  version: "1.0.0"

technical:
  language: python
  entryPoint: strategy.py

backtest:
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
  benchmark: BTC-USD
```

可选扩展：

- identity 下可加 `style` (trend|mean_reversion|dca|momentum|swing|hybrid)、`summary`、`description`、`license`、`changelog`、`author`、`createdAt`、`updatedAt`；
- `tags` **必须为字符串数组** (YAML list)，例如：`tags: [dca, btc, adaptive, crypto]`，不要生成 `tags: "dca, btc, adaptive, crypto"` 这种单一字符串；
- classification 下 `market` (Crypto|US|CN|HK|Forex|Commodity)、`assetClasses`、`frequency`；
- risk 下 `riskLevel` (low|medium|high)；
- `parameters` 数组等。

这些扩展字段的含义与约束应与《回测Server-fep-v1.1使用指南》中 4.2/4.2.1 的示例保持一致。

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
3. **打包**：校验通过后，在策略包目录下执行 `zip -r ../<name>.zip fep.yaml scripts/`（或等价命令），得到 ZIP 路径。
4. **提交**：调用 `backtest_remote_submit`，传入 ZIP 的 `filePath`（及可选 symbol、initial_capital、start_date、end_date、engine、budget_cap_usd）。

## 相关 Tools

| Tool                                                | 用途                                                    |
| --------------------------------------------------- | ------------------------------------------------------- |
| `backtest_remote_validate`                          | 校验策略包目录格式是否符合 fep v1.2，通过后才可打包上传 |
| `backtest_remote_submit`                            | 提交已打包的 ZIP 到远程回测服务                         |
| `backtest_remote_status` / `backtest_remote_report` | 查询任务状态与报告                                      |

总结：**先按本 skill 生成/补全策略包 → 用 backtest_remote_validate 校验 → 通过后再打包并 backtest_remote_submit**。
