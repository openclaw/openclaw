# FEP v2.0 策略包协议说明

> Findoo Exchange Protocol — 策略标准化格式规范
> 最后更新: 2026-03-19

---

## 1. 概述

FEP (Findoo Exchange Protocol) 是 Findoo 的策略标准格式。一个 FEP 策略包定义了策略的身份、参数、回测配置和风控规则。

**v2.0 核心理念**: 用户只需指定 `symbol`，服务端自动推断市场类型、数据源、货币、手续费和结算规则。

---

## 2. 目录结构

```
my-strategy/
├── fep.yaml              # 策略配置（必需）
└── scripts/
    ├── strategy.py       # 策略入口（必需）— 实现 compute() 或 select()
    ├── indicators.py     # 指标计算（可选）
    └── risk_manager.py   # 风控模块（可选）
```

打包与提交：

```bash
cd my-strategy && zip -r strategy.zip fep.yaml scripts/
curl -X POST /api/v1/tasks -H "X-API-Key: dev-key" -F "fep_package=@strategy.zip"
```

---

## 3. fep.yaml 完整 Schema

### 3.1 顶层字段

| 字段             | 类型   | 必填 | 说明                               |
| ---------------- | ------ | ---- | ---------------------------------- |
| `fep`            | string | 是   | 协议版本，`"2.0"`                  |
| `identity`       | object | 是   | 策略身份信息                       |
| `technical`      | object | 否   | 技术配置（默认 `strategy.py`）     |
| `parameters`     | list   | 否   | 策略参数定义                       |
| `backtest`       | object | 是   | 回测配置                           |
| `risk`           | object | 否   | 风控规则                           |
| `paper`          | object | 否   | 模拟盘配置                         |
| `classification` | object | 否   | 策略分类标签（展示用，引擎不读取） |

### 3.2 identity — 策略身份

| 字段          | 类型   | 必填 | 默认值     | 说明                               |
| ------------- | ------ | ---- | ---------- | ---------------------------------- |
| `id`          | string | 是   | —          | 唯一标识（如 `fin-cn-pingan-ema`） |
| `name`        | string | 是   | —          | 人类可读名称                       |
| `type`        | string | 否   | `strategy` | 类型                               |
| `version`     | string | 否   | `1.0.0`    | 语义化版本号                       |
| `style`       | string | 否   | `trend`    | 策略风格                           |
| `summary`     | string | 否   | `""`       | 简短描述                           |
| `tags`        | list   | 否   | `[]`       | 标签列表                           |
| `author.name` | string | 否   | —          | 作者名                             |

**style 可选值**: `trend`, `mean-reversion`, `momentum`, `value`, `growth`, `breakout`, `rotation`, `hybrid`

### 3.3 technical — 技术配置

| 字段          | YAML Key     | 默认值        | 说明                  |
| ------------- | ------------ | ------------- | --------------------- |
| `language`    | `language`   | `python`      | 编程语言              |
| `entry_point` | `entryPoint` | `strategy.py` | scripts/ 下的入口文件 |

### 3.4 parameters — 策略参数

```yaml
parameters:
  - name: fast_period
    default: 12
    type: integer # integer | number | string | boolean
    label: "快线周期" # 可选，显示名
    range: { min: 5, max: 50 } # 可选，取值范围
```

### 3.5 backtest — 回测配置

**核心字段（必填）**

| 字段                        | YAML Key                  | 类型   | 说明     |
| --------------------------- | ------------------------- | ------ | -------- |
| `symbol`                    | `symbol`                  | string | 交易品种 |
| `default_period.start_date` | `defaultPeriod.startDate` | string | 开始日期 |
| `default_period.end_date`   | `defaultPeriod.endDate`   | string | 结束日期 |
| `initial_capital`           | `initialCapital`          | float  | 初始资金 |

**可选字段**

| 字段        | YAML Key    | 默认值 | 说明                                                |
| ----------- | ----------- | ------ | --------------------------------------------------- |
| `timeframe` | `timeframe` | `1d`   | K 线周期: `1m`/`5m`/`15m`/`30m`/`1h`/`4h`/`1d`/`1w` |
| `universe`  | `universe`  | —      | 多标的配置（轮动策略用）                            |
| `rebalance` | `rebalance` | —      | 再平衡配置（多标的用）                              |

**服务端自动推断（用户无需指定）**

| 配置项   | 推断规则                                                                          |
| -------- | --------------------------------------------------------------------------------- |
| 市场类型 | `000001.SZ` → A股, `AAPL` → 美股, `BTC/USDT` → Crypto, `00700.HK` → 港股          |
| 数据源   | 可识别 symbol → DataHub 真实数据, 未知 → 合成数据                                 |
| 货币     | A股 → CNY, 美股 → USD, 港股 → HKD, Crypto → USDT                                  |
| 手续费   | A股: 佣金+印花税+过户费, 港股: 佣金+印花税+征费, 美股: 零佣金, Crypto: MakerTaker |
| 结算规则 | A股/ETF → T+1, 其余 → T+0                                                         |

**Symbol 格式与市场检测**

| 格式               | 市场   | 示例                     |
| ------------------ | ------ | ------------------------ |
| `XXX/YYY`          | Crypto | `BTC/USDT`, `ETH/BTC`    |
| `6位数.SZ/SH`      | A股    | `000001.SZ`, `600519.SH` |
| `5位数.SH` (5开头) | ETF    | `510300.SH`              |
| `000xxx.SH`        | 指数   | `000300.SH`              |
| `4-5位数.HK`       | 港股   | `00700.HK`               |
| `1-5大写字母`      | 美股   | `AAPL`, `NVDA`           |
| `字母+数字.交易所` | 期货   | `IF2503.CFX`             |

### 3.6 risk — 风控规则

| 字段                     | YAML Key               | 默认值 | 说明             |
| ------------------------ | ---------------------- | ------ | ---------------- |
| `max_drawdown_threshold` | `maxDrawdownThreshold` | `25`   | 最大回撤限制 (%) |
| `daily_loss_limit_pct`   | `dailyLossLimitPct`    | `5`    | 日亏损限制 (%)   |
| `max_trades_per_day`     | `maxTradesPerDay`      | `10`   | 日最大交易笔数   |

### 3.7 paper — 模拟盘配置（可选）

| 字段                   | YAML Key             | 默认值 | 说明               |
| ---------------------- | -------------------- | ------ | ------------------ |
| `bar_interval_seconds` | `barIntervalSeconds` | `60`   | 行情轮询间隔（秒） |
| `max_duration_hours`   | `maxDurationHours`   | `24`   | 最大运行时长       |
| `warmup_bars`          | `warmupBars`         | `100`  | 预热 K 线数        |
| `timeframe`            | `timeframe`          | `1d`   | 模拟盘 K 线周期    |

### 3.8 多标的配置（universe + rebalance）

用于轮动/选股策略，需实现 `select()` 而非 `compute()`。

```yaml
backtest:
  symbol: "000001.SZ" # 仍需填一个主 symbol
  universe:
    symbols:
      - "000001.SZ"
      - "000002.SZ"
      - "600519.SH"
      - "600036.SH"
  rebalance:
    frequency: monthly # daily | weekly | monthly
    maxHoldings: 2 # 最大同时持仓数
    weightMethod: equal # 权重分配方式
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 1000000
```

---

## 4. compute() 函数规范 — 单标的策略

### 4.1 函数签名

```python
# 模式 A: 无 context（简单策略）
def compute(data: pd.DataFrame) -> dict

# 模式 B: 带 context（推荐，可获取仓位和资金信息）
def compute(data: pd.DataFrame, context: dict | None = None) -> dict
```

引擎自动检测签名，决定是否传入 context。

### 4.2 输入: data DataFrame

最近 30~100 根 K 线（由 lookback_bars 决定，默认 100）。

| 分组              | 列名                                                                   | 可用市场 |
| ----------------- | ---------------------------------------------------------------------- | -------- |
| **OHLCV** (5)     | open, high, low, close, volume                                         | 全部市场 |
| **MACD** (3)      | macd_dif, macd_dea, macd                                               | 仅 A 股  |
| **KDJ** (3)       | kdj_k, kdj_d, kdj_j                                                    | 仅 A 股  |
| **RSI** (3)       | rsi_6, rsi_12, rsi_24                                                  | 仅 A 股  |
| **BOLL** (3)      | boll_upper, boll_mid, boll_lower                                       | 仅 A 股  |
| **CCI** (1)       | cci                                                                    | 仅 A 股  |
| **日频估值** (7)  | pe, total_mv, float_mv, turn_over, vol_ratio, total_share, float_share | 仅 A 股  |
| **季度财务** (19) | q_roe, q_eps, q_bps, q_netprofit_yoy, q_debt_to_assets 等              | 仅 A 股  |

### 4.3 输入: context dict

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

### 4.4 输出: 信号 dict

| action   | 必填字段                   | 可选字段                  | 说明                           |
| -------- | -------------------------- | ------------------------- | ------------------------------ |
| `buy`    | amount, price              | reason                    | 按金额买入（引擎自动计算股数） |
| `sell`   | —                          | percent, quantity, reason | 无参数=全仓卖, percent=按比例  |
| `hold`   | —                          | reason                    | 不操作                         |
| `target` | target_pct 或 target_value | reason                    | 调仓到目标权重/金额            |

**信号示例**:

```python
# 买入
{"action": "buy", "amount": 50000, "price": 10.5, "reason": "EMA 金叉"}

# 全仓卖出
{"action": "sell", "reason": "止损"}

# 卖出 50%
{"action": "sell", "percent": 0.5, "reason": "减仓"}

# 卖出指定数量
{"action": "sell", "quantity": 100, "reason": "卖 100 股"}

# 调仓到目标
{"action": "target", "target_pct": 0.6, "reason": "调仓到 60% 权益"}
```

---

## 5. select() 函数规范 — 多标的策略

### 5.1 函数签名

```python
def select(universe: dict[str, pd.DataFrame]) -> list[str]
```

### 5.2 输入: universe

```python
{
    "000001.SZ": DataFrame[open, high, low, close, volume],  # 最近 N 根 K 线
    "000002.SZ": DataFrame[open, high, low, close, volume],
    "600519.SH": DataFrame[open, high, low, close, volume],
    ...
}
```

### 5.3 输出: 选中标的列表

```python
# 返回按优先级排序的 symbol 列表
# 引擎自动截取 maxHoldings 个，等权分配资金
["600519.SH", "000001.SZ", "000002.SZ"]
```

### 5.4 完整示例

```python
import numpy as np

def select(universe):
    """动量评分选股"""
    scores = []
    for symbol, df in universe.items():
        close = df["close"].values
        if len(close) < 20:
            continue
        # 20 日收益率作为动量得分
        momentum = (close[-1] / close[-20]) - 1
        scores.append((symbol, momentum))

    # 按动量降序排列
    scores.sort(key=lambda x: x[1], reverse=True)
    return [s[0] for s in scores]
```

---

## 6. 安全沙箱规则

### 白名单 — 允许的 import

```python
import numpy as np
import pandas as pd
import math, statistics
from collections import defaultdict
from itertools import combinations
import datetime
import ta                      # 技术指标库
from dataclasses import dataclass
from typing import Optional
```

### 禁止的 import（AST 扫描检测）

```
os, subprocess, sys, shutil, socket, http, ftplib, smtplib,
ctypes, importlib, code, compile, eval, exec, pickle, shelve,
multiprocessing, threading, signal, resource, pathlib
```

### 黑名单 — 禁止的模块（28 个前缀）

```
os, sys, subprocess, socket, requests, urllib, shutil, ctypes, signal,
threading, multiprocessing, concurrent, asyncio, io, pathlib, tempfile,
importlib, code, codeop, compileall, pickle, shelve, marshal,
http, xmlrpc, ftplib, smtplib, webbrowser, resource
```

### 黑名单 — 禁止的函数调用（16 个）

```
exec, eval, compile, open, __import__, globals, locals,
getattr, setattr, delattr, vars, dir, breakpoint, exit, quit, input
```

### 禁止的行为

- `datetime.now()` / `date.today()` — 破坏回测/实盘一致性
- 网络请求 (requests, urllib, httpx)
- 文件 I/O (open, read, write)
- 数据库访问

### 校验机制

采用**正则预筛 + AST 深度检查**双重机制：

1. 正则快速扫描危险模式（import 语句、eval/exec 调用等）
2. AST 解析遍历：import 白名单验证 + 禁止函数调用检测
3. 入口函数检查：验证 compute() 或 select() 存在且参数正确

---

## 8. 回测结果 (TaskResultData)

### 7.1 核心指标

| 字段 (camelCase) | 类型  | 说明                     |
| ---------------- | ----- | ------------------------ |
| `totalReturn`    | float | 总收益率                 |
| `sharpe`         | float | Sharpe 比率 (252 天年化) |
| `maxDrawdown`    | float | 最大回撤（负值）         |
| `totalTrades`    | int   | 完整交易轮回数           |
| `winRate`        | float | 胜率                     |
| `profitFactor`   | float | 利润因子                 |

### 7.2 收益分析

| 字段                | 类型  | 说明                       |
| ------------------- | ----- | -------------------------- |
| `sortino`           | float | Sortino 比率               |
| `annualizedReturn`  | float | CAGR 年化收益              |
| `calmar`            | float | Calmar 比率 (CAGR / MaxDD) |
| `returnsVolatility` | float | 收益波动率                 |
| `riskReturnRatio`   | float | 风险回报比                 |

### 7.3 交易分析

| 字段                     | 类型  | 说明          |
| ------------------------ | ----- | ------------- |
| `expectancy`             | float | 每笔期望收益  |
| `avgWinner` / `avgLoser` | float | 平均盈/亏     |
| `maxWinner` / `maxLoser` | float | 最大单笔盈/亏 |
| `longRatio`              | float | 多头占比      |

### 7.4 扩展指标

| 字段                                | 类型   | 说明          |
| ----------------------------------- | ------ | ------------- |
| `pnlTotal`                          | float  | 总盈亏金额    |
| `startingBalance` / `endingBalance` | float  | 初始/最终资金 |
| `backtestStart` / `backtestEnd`     | string | 回测日期范围  |
| `totalOrders`                       | int    | 总订单数      |

### 7.5 时序数据

| 字段             | 类型       | 格式                                         | 说明                                     |
| ---------------- | ---------- | -------------------------------------------- | ---------------------------------------- |
| `equityCurve`    | list[dict] | `{"date": "2024-01-02", "equity": 100000.0}` | 每日权益曲线（含未实现盈亏，~242 点/年） |
| `drawdownCurve`  | list[dict] | `{"date": "2024-01-02", "drawdown": 0.0}`    | 每日回撤曲线                             |
| `monthlyReturns` | list[dict] | `{"month": "2024-01", "return": 0.0}`        | 月度收益（含首月）                       |
| `trades`         | list[dict] | 见下表                                       | 完整交易日志                             |

**trades 条目格式**:

| 字段           | 类型   | 说明                     |
| -------------- | ------ | ------------------------ |
| `open_date`    | string | 开仓时间                 |
| `close_date`   | string | 平仓时间                 |
| `side`         | string | 方向 (BUY)               |
| `quantity`     | float  | 数量                     |
| `avg_open`     | float  | 平均开仓价               |
| `avg_close`    | float  | 平均平仓价               |
| `realized_pnl` | string | 已实现盈亏（含货币单位） |
| `return_pct`   | float  | 收益率                   |

---

## 9. 完整示例

### 8.1 最小配置（新手入门）

```yaml
fep: "2.0"
identity:
  id: my-first-strategy
  name: "我的第一个策略"
backtest:
  symbol: "600519.SH"
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 100000
```

```python
# scripts/strategy.py
import numpy as np

def compute(data, context=None):
    close = data["close"].values.astype(float)
    if len(close) < 20:
        return {"action": "hold", "reason": "数据不足"}

    price = float(close[-1])
    ma20 = float(np.mean(close[-20:]))
    has_position = context and context.get("position") is not None

    if has_position:
        position = context["position"]
        avg_cost = position.get("avg_cost", price)
        pnl = (price - avg_cost) / avg_cost if avg_cost > 0 else 0
        if pnl > 0.03:
            return {"action": "sell", "reason": f"止盈 {pnl*100:.1f}%"}
        if pnl < -0.05:
            return {"action": "sell", "reason": f"止损 {pnl*100:.1f}%"}
        if price < ma20:
            return {"action": "sell", "reason": "跌破 MA20"}

    if not has_position and price > ma20:
        return {"action": "buy", "amount": 50000, "price": price,
                "reason": f"突破 MA20={ma20:.2f}"}

    return {"action": "hold", "reason": f"MA20={ma20:.2f}"}
```

### 8.2 A 股 EMA 趋势策略（完整配置）

```yaml
fep: "2.0"
identity:
  id: fin-cn-pingan-ema
  name: "平安银行 EMA Trend Following"
  version: "1.0.0"
  style: trend
  summary: "EMA crossover trend-following strategy for 平安银行"
  tags: [a-share, trend, ema]
technical:
  entryPoint: strategy.py
parameters:
  - name: ema_fast
    default: 12
    type: integer
  - name: ema_slow
    default: 26
    type: integer
backtest:
  symbol: "000001.SZ"
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 100000
risk:
  maxDrawdownThreshold: 25
  dailyLossLimitPct: 5
  maxTradesPerDay: 5
```

### 8.3 多标的轮动策略

```yaml
fep: "2.0"
identity:
  id: fin-cn-rotation
  name: "A股动量轮动"
  style: rotation
backtest:
  symbol: "000001.SZ"
  universe:
    symbols: ["000001.SZ", "000002.SZ", "600519.SH", "600036.SH", "000858.SZ"]
  rebalance:
    frequency: monthly
    maxHoldings: 2
    weightMethod: equal
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 1000000
risk:
  maxDrawdownThreshold: 30
```

```python
# scripts/strategy.py — 使用 select() 而非 compute()
import numpy as np

def select(universe):
    scores = []
    for symbol, df in universe.items():
        close = df["close"].values
        if len(close) < 20:
            continue
        momentum = (close[-1] / close[-20]) - 1
        volatility = float(np.std(np.diff(close) / close[:-1]))
        score = momentum - 0.5 * volatility
        scores.append((symbol, score))
    scores.sort(key=lambda x: x[1], reverse=True)
    return [s[0] for s in scores]
```

---

## 10. v1.3 → v2.0 迁移

```diff
- fep: "1.3"
+ fep: "2.0"

  backtest:
+   symbol: "000001.SZ"
    defaultPeriod:
      startDate: "2024-01-01"
      endDate: "2024-12-31"
    initialCapital: 100000
-   currency: CNY
-   commissionRate: 0.001
-   dataSource: datahub
```

Legacy 字段（`dataSource`, `currency`, `commissionRate`, `market` 等）写入不报错，但被服务端忽略。

---

## 11. 现有示例策略索引

| 策略 ID             | Symbol    | 市场   | 风格           | 入口函数  |
| ------------------- | --------- | ------ | -------------- | --------- |
| fin-btc-trend-ema   | BTC/USDT  | Crypto | trend          | compute() |
| fin-cn-pingan-ema   | 000001.SZ | A股    | trend          | compute() |
| fin-us-aapl-ema     | AAPL      | 美股   | trend          | compute() |
| fin-hk-tencent-ema  | 00700.HK  | 港股   | trend          | compute() |
| fin-cn-rotation     | 000001.SZ | A股    | rotation       | select()  |
| fin-cn-atr-channel  | 002594.SZ | A股    | momentum       | compute() |
| fin-cn-dualma-cross | 000651.SZ | A股    | trend          | compute() |
| fin-cn-meanrev-boll | 000858.SZ | A股    | mean-reversion | compute() |
| fin-cn-rsi-swing    | 600036.SH | A股    | mean-reversion | compute() |
| fin-cn-multi-fusion | 000333.SZ | A股    | hybrid         | compute() |

所有示例位于 `data/strategy/example/` 目录。
