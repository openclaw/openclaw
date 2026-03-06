---
name: fin-cn-market
description: "A-share market specifics — shareholder trades, repurchase, pledge risk, lock-up expiry, sector rotation, IPO strategy. Use when: user asks about A-share unique features, 打新, 解禁, 质押, or concept/theme sectors. NOT for: general stock analysis (use fin-equity)."
metadata: { "openclaw": { "emoji": "🇨🇳", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# A-Share Market Specifics

A 股市场特色分析。聚焦 A 股独有的筹码面、板块轮动、政策敏感度、打新策略四大维度，使用 **fin_stock** 特色 endpoint 和 **fin_index** 同花顺概念指数。

## When to Use

- "茅台大股东最近减持了吗"
- "最近有哪些公司在回购"
- "高质押的股票有什么风险"
- "下周有多少解禁"
- "新能源板块还能轮到吗"
- "这周打新有什么好标的"
- "茅台股东人数变化"
- "同花顺 ChatGPT 概念指数怎么走"

## When NOT to Use

- 通用个股分析 (财报/估值) → use `/fin-equity`
- 港股特色分析 → use `/fin-hk-market`
- 宏观经济数据 → use `/fin-macro`
- 龙虎榜 / 大宗交易 → use `/fin-market-radar`
- 多因子选股 → use `/fin-factor-screen`

## 维度一: 筹码面分析

### 1. 股东增减持

#### 工具

```
fin_stock(symbol="600519.SH", endpoint="ownership/shareholder_trade", limit=50)
```

#### 参数

| Parameter  | Type   | Required | Format                      | Default | Example    |
| ---------- | ------ | -------- | --------------------------- | ------- | ---------- |
| symbol     | string | Yes      | 600519.SH                   | —       | 600519.SH  |
| endpoint   | string | Yes      | ownership/shareholder_trade | —       | —          |
| start_date | string | No       | YYYY-MM-DD                  | —       | 2025-01-01 |
| limit      | number | No       | 1-5000                      | 200     | 50         |

#### 分析逻辑

| 信号                      | 含义           | 风险等级 |
| ------------------------- | -------------- | -------- |
| 大股东连续减持 > 3 次     | 资金撤离信号   | 🔴       |
| 高管集中减持              | 内部人不看好   | 🔴       |
| 大股东增持 (尤其自掏腰包) | 看好公司前景   | 🟢       |
| 员工持股计划增持          | 利益绑定       | 🟢       |
| 减持公告 + 股价高位       | 高位套现       | 🔴       |
| 减持后质押比例上升        | 可能资金链紧张 | 🔴🔴     |

### 2. 公司回购

#### 工具

```
fin_stock(symbol="600519.SH", endpoint="ownership/repurchase", limit=20)
```

#### 分析逻辑

| 回购类型     | 解读                 | 积极程度   |
| ------------ | -------------------- | ---------- |
| 注销型回购   | 减少总股本，提升 EPS | 最积极     |
| 员工激励回购 | 用于股权激励         | 中性偏积极 |
| 市值管理回购 | 稳定股价             | 中性       |
| 回购但未注销 | 可能未来仍会卖出     | 中性偏消极 |

**回购力度评估:**

- 回购金额 / 市值 > 1%: 力度较大
- 回购价格上限 vs 当前价: 上限远高于现价 → 真诚度高
- 实际回购进度 vs 计划: 进度 > 50% → 执行力好

### 3. 质押风险

#### 工具

```
fin_stock(symbol="600519.SH", endpoint="pledge/stat")
```

#### 质押风险分级

| 质押比例 | 风险等级 | 说明                         |
| -------- | -------- | ---------------------------- |
| < 10%    | 🟢       | 安全                         |
| 10%-30%  | 🟡       | 需关注                       |
| 30%-50%  | 🔴       | 高风险，股价下跌可能触发平仓 |
| > 50%    | 🔴🔴     | 极高风险，随时可能爆仓       |

**质押平仓线分析:**

```
预警线 = 质押价格 × 160% (通常)
平仓线 = 质押价格 × 140% (通常)

当前价 < 预警线 → 需追加担保物
当前价 < 平仓线 → 强制平仓风险
```

**连锁风险:**

```
高质押 + 股价下跌
  → 触发平仓线
  → 被迫卖出
  → 股价进一步下跌
  → 更多质押触发平仓
  → 踩踏式下跌
```

### 4. 股东人数

#### 工具

```
fin_stock(symbol="600519.SH", endpoint="ownership/holder_number", limit=12)
```

#### 筹码集中度分析

| 变化趋势         | 含义                     | 信号     |
| ---------------- | ------------------------ | -------- |
| 股东人数连续减少 | 筹码集中 (机构/大户吸筹) | 🟢 看多  |
| 股东人数连续增加 | 筹码分散 (机构派发)      | 🔴 看空  |
| 单季度骤降 > 20% | 可能有重大利好未公开     | 高度关注 |
| 户均持股金额上升 | 大户增持                 | 🟢       |

### 5. 解禁日历

#### 工具

```
fin_stock(symbol="600519.SH", endpoint="ownership/share_float", limit=20)
```

#### 解禁冲击评估

| 评估维度         | 高冲击             | 低冲击              |
| ---------------- | ------------------ | ------------------- |
| 解禁比例 vs 流通 | > 10% 流通盘       | < 3% 流通盘         |
| 解禁股东类型     | 财务投资者 (PE/VC) | 控股股东/战略投资者 |
| 持有成本 vs 现价 | 成本远低于现价     | 成本接近或高于现价  |
| 历史减持行为     | 该股东有减持习惯   | 从未减持            |
| 市场环境         | 弱势市场           | 强势市场            |

**解禁减持时间规律:**

- 解禁当日: 通常不会大量卖出 (大宗交易需报备)
- 解禁后 1-2 周: 减持高峰
- 大股东: 90 天内减持 ≤ 1% (集合竞价)
- 大宗交易: 不受单日限制，但折价交易

## 维度二: 板块轮动

### 同花顺概念指数

#### 工具

```
# 获取概念指数列表
fin_index(endpoint="thematic/ths_index")

# 获取特定概念指数行情
fin_index(symbol="885760.TI", endpoint="thematic/ths_daily", limit=60)

# 获取概念成分股
fin_index(symbol="885760.TI", endpoint="thematic/ths_member")
```

#### 热门概念跟踪

| 概念板块 | 示例代码  | 跟踪要点                |
| -------- | --------- | ----------------------- |
| 人工智能 | 885760.TI | ChatGPT/算力/应用端轮动 |
| 新能源车 | 885806.TI | 整车/电池/充电桩        |
| 半导体   | 885784.TI | 设计/制造/封测/设备     |
| 医药生物 | 885737.TI | 创新药/CXO/医疗器械     |
| 军工     | 885707.TI | 航空/航天/电子/材料     |

### 板块轮动识别

#### 轮动周期模型

```
典型轮动路径 (牛市):
  券商 → 周期 (有色/化工) → 消费 (白酒/医药) → 科技 (半导体/软件) → 小盘/垃圾股

典型轮动路径 (结构性行情):
  政策催化板块 → 业绩兑现板块 → 低位补涨板块

识别工具:
  Step 1: fin_index(endpoint="thematic/ths_index") → 全部概念列表
  Step 2: 选取 10-15 个核心概念 → fin_index(endpoint="thematic/ths_daily")
  Step 3: 计算 5 日/20 日涨跌幅排名变化
  Step 4: 排名上升最快的概念 = 当前轮动方向
```

#### 轮动信号

| 信号             | 含义             | 操作建议    |
| ---------------- | ---------------- | ----------- |
| 板块启动 3 日内  | 主升浪初期       | 关注龙头    |
| 板块连涨 > 5 日  | 主升浪中期       | 跟随但控仓  |
| 板块高位放量滞涨 | 可能见顶         | 减仓/换板块 |
| 板块缩量回调     | 正常调整         | 逢低布局    |
| 补涨股开始表现   | 板块行情接近尾声 | 准备切换    |

## 维度三: 政策敏感度

### 政策分类与影响

| 政策类型 | 影响方向 | 影响行业              | 持续时间  |
| -------- | -------- | --------------------- | --------- |
| 货币宽松 | 利好     | 券商/地产/有色        | 1-3 个月  |
| 财政刺激 | 利好     | 基建/建材/机械        | 3-6 个月  |
| 产业扶持 | 利好     | 新能源/半导体/AI      | 6-12 个月 |
| 监管收紧 | 利空     | 教育/互联网/游戏      | 立即      |
| 环保政策 | 分化     | 利好环保/利空高污染   | 长期      |
| 贸易摩擦 | 分化     | 利好自主可控/利空出口 | 波动      |

### 政策分析工具链

```
Step 1: 判断政策类型 (货币/财政/产业/监管)
Step 2: fin_index(endpoint="thematic/ths_index") → 找相关概念指数
Step 3: fin_index(endpoint="thematic/ths_daily") → 看板块反应
Step 4: fin_index(endpoint="thematic/ths_member") → 找受益/受损标的
Step 5: fin_stock(endpoint="fundamental/ratios") → 评估受影响标的估值
```

## 维度四: 打新策略

### IPO 日历查询

```
fin_market(endpoint="discovery/new_share")
```

注: 使用 fin_market 的 discovery/new_share 端点查看新股上市/申购日历。

### 打新收益分析

#### A 股打新特点

- 市值门槛: 沪市 1 万、深市 5000 (T-2 日市值)
- 中签率: 通常 0.02%-0.05% (科创板略高)
- 首日涨幅: 注册制后分化加大
- 破发风险: 注册制 IPO 约 10-20% 首日破发

#### 打新策略矩阵

| 维度       | 优先打        | 谨慎打       | 回避           |
| ---------- | ------------- | ------------ | -------------- |
| 发行市盈率 | < 行业均值    | 接近行业均值 | > 行业均值 50% |
| 发行规模   | 适中 (5-20亿) | 小 (< 2亿)   | 超大 (> 50亿)  |
| 行业景气度 | 高景气        | 一般         | 衰退行业       |
| 公司质量   | ROE > 15%     | ROE 10-15%   | ROE < 10%      |
| 超募比例   | 无超募        | 适度超募     | 大幅超募       |

### 打新后操作

```
中签后策略:
  1. 核准制 (主板): 开板后观察 1-2 天，放量滞涨卖出
  2. 注册制 (科创/创业): 首日可卖，关注:
     - 涨幅 > 100%: 分批卖出
     - 涨幅 30-100%: 第二日观察
     - 破发: 评估基本面，止损或持有

破发判断:
  fin_stock(endpoint="price/historical", limit=5)  # 上市后走势
  fin_stock(endpoint="fundamental/ratios")          # 估值合理性
```

## 综合分析模板

### A 股个股深度 (特色维度)

```
Step 1: 筹码面扫描
  fin_stock(endpoint="ownership/shareholder_trade", limit=20)  → 增减持
  fin_stock(endpoint="pledge/stat")                   → 质押
  fin_stock(endpoint="ownership/holder_number", limit=8)        → 股东人数
  fin_stock(endpoint="ownership/share_float", limit=10)         → 解禁

Step 2: 回购信号
  fin_stock(endpoint="ownership/repurchase", limit=10)          → 回购进度

Step 3: 概念归属
  fin_index(endpoint="thematic/ths_index")                      → 所属概念
  fin_index(endpoint="thematic/ths_daily")                      → 概念热度

Step 4: 综合研判
  筹码集中 + 大股东增持 + 回购 + 概念热 → 多头信号强
  筹码分散 + 减持 + 高质押 + 解禁 → 风险高
```

### 板块轮动扫描 (周度)

```
Step 1: fin_index(endpoint="thematic/ths_index") → 概念列表
Step 2: 批量 fin_index(endpoint="thematic/ths_daily", limit=5) → 本周涨幅
Step 3: 排序 → Top 5 涨幅板块 + Bottom 5 跌幅板块
Step 4: Top 5 板块 → fin_index(endpoint="thematic/ths_member") → 龙头股
Step 5: 结合政策/事件催化因素 → 判断持续性
```

## Data Notes

- 股东增减持: 公告后 T+1 更新，存在滞后
- 质押数据: 每周更新
- 股东人数: 季报/半年报/年报披露 (非实时)
- 解禁数据: 提前公告，可预判
- 概念指数: 同花顺编制，日内更新
- 打新日历: 提前 1-2 天公布

## Response Guidelines

- 筹码面分析必须多维度交叉验证 (增减持 + 质押 + 股东人数)
- 板块轮动用表格展示涨幅排名
- 解禁分析需注明解禁日期、规模、股东类型
- 质押风险用红黄绿三色标注
- 打新建议标注发行价、市盈率、中签率
- 注明数据截止日期
- 特别标注 A 股交易规则差异 (T+1、涨跌停、注册制 vs 核准制)
