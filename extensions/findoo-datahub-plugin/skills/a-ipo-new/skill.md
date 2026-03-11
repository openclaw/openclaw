---
name: fin-a-ipo-new
description: "A-share IPO subscription guide — new share calendar, quality assessment, break-even risk warning, quota calculator, post-listing tracking. Use when: user asks about A-share IPO subscription (打新), new share calendar, IPO quality evaluation, subscription quota/eligibility, break-even risk, or post-listing performance. NOT for: secondary market stock analysis (use fin-a-share), market-wide scan (use fin-a-share-radar), next-new-stock (次新股) trend analysis (use fin-a-share)."
metadata: { "openclaw": { "emoji": "🎯", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# A股打新攻略 (A-Share IPO Subscription Guide)

A 股打新专项分析：新股日历、质量评估、破发预警、市值配售计算、上市后跟踪。覆盖主板、科创板、创业板、北交所四大板块的差异化规则。

## When to Use

- "本周有哪些新股可以申购" / "IPO calendar this week"
- "这只新股值不值得打" / "should I subscribe to this IPO"
- "科创板新股质量怎么样" / "STAR market IPO quality"
- "我有20万市值能打几个签" / "how many lots can I apply for"
- "新股会不会破发" / "IPO break-even risk"
- "XX股票上市后走势怎么样" / "post-IPO performance"
- "打新需要什么条件" / "IPO subscription eligibility"
- "最近新股中签率多少" / "recent IPO winning rate"

## When NOT to Use

- 次新股走势/技术面分析 (上市已超1个月的股票) → use `/fin-a-share`
- 市场整体异常检测/盘后复盘 → use `/fin-a-share-radar`
- 量化因子选股 → use `/fin-factor-screen`
- ETF/基金分析 → use `/fin-etf-fund`
- 宏观经济数据 → use `/fin-macro`

## Tools & Parameters

### fin_market — 新股日历 & 市场数据

| Parameter | Type   | Required | Format             | Default | Example             |
| --------- | ------ | -------- | ------------------ | ------- | ------------------- |
| endpoint  | string | Yes      | see endpoint table | —       | discovery/new_share |

#### Key Endpoints

| endpoint                | Description      | Example                                        |
| ----------------------- | ---------------- | ---------------------------------------------- |
| `discovery/new_share`   | IPO calendar     | `fin_market(endpoint="discovery/new_share")`   |
| `market/trade_calendar` | Trading calendar | `fin_market(endpoint="market/trade_calendar")` |

### fin_stock — 个股数据 (可比公司估值/新股上市后走势)

| Parameter | Type   | Required | Format             | Default | Example            |
| --------- | ------ | -------- | ------------------ | ------- | ------------------ |
| symbol    | string | Yes      | `{code}.SH/SZ`     | —       | 688001.SH          |
| endpoint  | string | Yes      | see endpoint table | —       | fundamental/ratios |
| limit     | number | No       | 1-5000             | 200     | 20                 |

#### Key Endpoints

| endpoint             | Description        | Example                                                                |
| -------------------- | ------------------ | ---------------------------------------------------------------------- |
| `profile`            | Company overview   | `fin_stock(symbol="688001.SH", endpoint="profile")`                    |
| `price/historical`   | Post-listing OHLCV | `fin_stock(symbol="688001.SH", endpoint="price/historical", limit=20)` |
| `fundamental/ratios` | PE/PB valuation    | `fin_stock(symbol="688001.SH", endpoint="fundamental/ratios")`         |

### fin_index — 行业板块归属

| endpoint              | Description      | Example                                                          |
| --------------------- | ---------------- | ---------------------------------------------------------------- |
| `thematic/ths_index`  | THS concept list | `fin_index(endpoint="thematic/ths_index")`                       |
| `thematic/ths_member` | Index members    | `fin_index(endpoint="thematic/ths_member", ts_code="885XXX.TI")` |

## A股打新核心规则 (硬编码知识)

### 板块差异对照表

| 板块   | 涨跌幅限制           | 定价方式       | 申购门槛             | 最小申购单位 |
| ------ | -------------------- | -------------- | -------------------- | ------------ |
| 主板   | 上市首5日±44% 后±10% | 23倍PE窗口指导 | 持有对应市场市值     | 500股/签     |
| 科创板 | 上市首5日不限 后±20% | 市场化定价     | 50万证券资产+2年经验 | 500股/签     |
| 创业板 | 上市首5日不限 后±20% | 市场化定价     | 10万证券资产+2年经验 | 500股/签     |
| 北交所 | 上市首日不限 后±30%  | 市场化定价     | 50万证券资产+2年经验 | 100股起      |

### 申购流程时间线

| 日期  | 事件     | 注意事项                                  |
| ----- | -------- | ----------------------------------------- |
| T日   | 申购日   | 顶格申购 = 用最大可申购额度               |
| T+1日 | 配号     | 系统自动完成                              |
| T+2日 | 中签缴款 | 逾期未缴款视为放弃                        |
| —     | 弃购惩罚 | 连续12个月内累计3次中签未缴款 → 禁打6个月 |

### 市值配售规则

| 市场 | 每签所需市值 | 每签股数 | 说明                  |
| ---- | ------------ | -------- | --------------------- |
| 沪市 | 1万元        | 500股    | 持有沪市非限售A股市值 |
| 深市 | 5000元       | 500股    | 持有深市非限售A股市值 |

⚠️ 同一身份证下多账户只算一次，分账户打新无效。

## Analysis Patterns

### 1. 本周打新日历 (IPO Calendar)

```
Step 1: fin_market(endpoint="discovery/new_share") → 获取近期新股列表
Step 2: fin_market(endpoint="market/trade_calendar") → 确认交易日

输出框架:
  按板块分类展示:
  | 申购日 | 代码 | 名称 | 板块 | 发行价(元) | 发行PE | 募资额(亿) | 顶格需市值 |
  |--------|------|------|------|-----------|--------|-----------|-----------|

  ⚠️ 科创板/创业板需额外门槛，提醒用户确认账户权限
  ⚠️ 多只同日申购时，按板块分别计算顶格市值
  💡 主板 23 倍 PE 限价 → 几乎必有首日涨幅，优先申购
```

### 2. 新股质量评估 (IPO Quality Assessment)

```
Step 1: fin_market(endpoint="discovery/new_share") → 获取新股基本信息(发行价/PE/募资额)
Step 2: fin_index(endpoint="thematic/ths_index") → 所属行业/概念板块近期走势
Step 3: fin_stock(endpoint="fundamental/ratios", symbol=可比公司) → 同行业已上市公司 PE/PB

质量评估维度:

Dim 1 — 发行估值 vs 行业:
  主板: 发行 PE ≤ 23 倍 (窗口指导) → 折价发行，打新价值高
  科创/创业:
  ├─ 发行 PE < 行业平均 0.8 倍 → 低估，建议申购
  ├─ 发行 PE ≈ 行业平均 → 中性，需看基本面
  ├─ 发行 PE > 行业平均 1.2 倍 → 偏高，谨慎
  └─ 发行 PE > 行业平均 1.5 倍 → 高估，破发风险大

Dim 2 — 募资规模效应:
  ├─ < 5 亿 → 小盘股，稀缺性强，弹性大
  ├─ 5-10 亿 → 中等，正常
  ├─ 10-50 亿 → 大盘股，稀缺性一般
  └─ > 50 亿 → 超大盘，历史破发率较高

Dim 3 — 行业景气度:
  板块近 20 日涨幅:
  ├─ > +5% → 行业热度高，上市溢价大
  ├─ -5% ~ +5% → 中性
  └─ < -5% → 行业低迷，上市可能承压

⚠️ 三个维度综合判断：低PE + 小募资 + 热门行业 = 最佳打新标的
⚠️ 高PE + 大募资 + 冷门行业 = 破发高危
💡 主板新股因 23 倍 PE 限价，质量评估主要看行业和募资额
```

### 3. 新股上市后跟踪 (Post-IPO Tracking)

```
Step 1: fin_stock(endpoint="price/historical", symbol=新股代码, limit=20) → 上市后走势
Step 2: fin_stock(endpoint="profile", symbol=新股代码) → 公司概况

关键指标解读:

主板新股:
  连续一字涨停板天数 → 开板日是关键卖点
  ├─ 开板日换手率 > 50% → 抛压一次性释放，可能见底
  ├─ 开板后缩量回调 → 等企稳再关注
  └─ 开板后继续放量上涨 → 极度强势(罕见)

注册制新股 (科创/创业/北交所):
  上市首5日无涨跌幅限制:
  ├─ 首日涨幅 > 100% → 情绪过热，短期回调概率大
  ├─ 首日涨幅 30-100% → 正常范围
  ├─ 首日涨幅 0-30% → 偏弱，需关注基本面
  └─ 首日破发 → 弃购者幸运，中签者需评估止损

  第5日后关注:
  ├─ 换手率 > 50% → 筹码充分换手，短期底部信号
  └─ 换手率 < 20% → 仍有抛压未释放

⚠️ 新股上市首5日后进入正常涨跌幅限制
💡 开板/首5日后的走势比首日涨幅更有参考价值
```

### 4. 市值配售计算器 (Quota Calculator)

```
用户输入: 持有沪市/深市市值

沪市计算:
  可申购签数 = floor(沪市市值 / 10000)
  可申购股数 = 签数 × 500
  顶格申购所需市值 = 新股网上发行量 / 500 × 10000 (上限)

深市计算:
  可申购签数 = floor(深市市值 / 5000)
  可申购股数 = 签数 × 500
  顶格申购所需市值 = 新股网上发行量 / 500 × 5000 (上限)

权限检查:
  ├─ 科创板: 证券资产 ≥ 50 万 + 2 年交易经验 → 才可申购
  ├─ 创业板: 证券资产 ≥ 10 万 + 2 年交易经验 → 才可申购
  └─ 北交所: 证券资产 ≥ 50 万 + 2 年交易经验 → 才可申购

⚠️ 市值计算为 T-2 日前 20 个交易日日均市值
⚠️ 同一身份证下多个证券账户合并计算，但只能选一个账户申购
💡 建议沪深两市均衡配置市值，覆盖更多打新机会
```

### 5. 破发风险预警 (Break-Even Risk Warning)

```
Step 1: fin_market(endpoint="discovery/new_share") → 获取新股发行信息
Step 2: fin_stock(endpoint="fundamental/ratios", symbol=可比公司) → 行业估值
Step 3: fin_index(endpoint="thematic/ths_index") → 行业走势

破发风险评分 (0-100, 越高越危险):

Signal 1 — 估值泡沫 (0-30):
  发行 PE / 行业平均 PE 比值
  ├─ < 0.8 → 0 分
  ├─ 0.8-1.0 → 5 分
  ├─ 1.0-1.2 → 10 分
  ├─ 1.2-1.5 → 20 分
  └─ > 1.5 → 30 分

Signal 2 — 募资规模 (0-20):
  ├─ < 5 亿 → 0 分
  ├─ 5-10 亿 → 5 分
  ├─ 10-30 亿 → 10 分
  ├─ 30-50 亿 → 15 分
  └─ > 50 亿 → 20 分

Signal 3 — 行业热度 (0-20):
  所属板块近 20 日涨跌幅
  ├─ > +10% → 0 分 (极热)
  ├─ +5% ~ +10% → 5 分
  ├─ 0% ~ +5% → 10 分
  ├─ -5% ~ 0% → 15 分
  └─ < -5% → 20 分 (冰冷)

Signal 4 — 板块属性 (0-15):
  ├─ 主板 (23 倍 PE 窗口指导) → 0 分
  ├─ 创业板 (市场化定价) → 8 分
  ├─ 科创板 (市场化定价) → 10 分
  └─ 北交所 (流动性偏弱) → 15 分

Signal 5 — 市场情绪 (0-15):
  近期新股首日平均涨幅
  ├─ > 100% → 0 分
  ├─ 50-100% → 5 分
  ├─ 20-50% → 8 分
  ├─ 0-20% → 12 分
  └─ < 0% (近期有破发) → 15 分

破发风险等级:
  ├─ 0-20 → 极低 (放心打)
  ├─ 20-40 → 低 (大概率安全)
  ├─ 40-55 → 中等 (需评估)
  ├─ 55-70 → 较高 (谨慎申购)
  ├─ 70-85 → 高 (建议放弃)
  └─ 85-100 → 极高 (大概率破发)

⚠️ 注册制后破发已常态化，不再是"闭眼打新"时代
⚠️ 主板因 23 倍 PE 限价，破发风险极低 (评分通常 <20)
💡 如果近 1 个月有 3+ 只新股破发 → 市场情绪极差，建议暂停打新
```

## Data Notes

- **新股日历**: `discovery/new_share` 提供近期 IPO 列表，含发行价、PE、申购日期等
- **可比估值**: 需手动选取同行业已上市公司的 `fundamental/ratios` 进行比较
- **行业数据**: `thematic/ths_index` 提供行业/概念板块走势，用于判断行业景气度
- **中签率**: 新股日历数据可能包含中签率，若无则需用"发行量/申购总量"估算
- **上市后走势**: 使用 `price/historical` 获取，需等新股上市交易后才有数据
- **A 股行情**: Tushare 提供，收盘后 ~18:00 更新，非实时
- **北交所**: 数据覆盖可能不如主板/创业板/科创板完整

## Response Guidelines

### 数字格式

- 发行价: 精确到分 (如 "发行价 28.56 元")
- 发行 PE: 保留两位小数 (如 "发行 PE 22.98 倍")
- 募资额: > 1 亿用"亿元"，< 1 亿用"万元"
- 中签率: 保留四位小数百分比 (如 "0.0342%")
- 市值: 用"万元"单位 (如 "需持有沪市市值 20 万元")
- 涨幅: +45.6% / -8.2% (始终带 +/- 符号)

### 必须包含

- 申购日期及缴款截止日 (T+2)
- 板块属性及对应门槛提醒 (科创50万/创业板10万)
- 破发风险评级 (注册制新股必须给出)
- 主板新股明确标注 "23 倍 PE 窗口指导，破发风险极低"
- 弃购惩罚提醒 ("中签后务必 T+2 日缴款，累计 3 次弃购将被禁打 6 个月")

### 展示方式

- 打新日历 → 按板块分类表格，标注门槛
- 质量评估 → 三维评分 + 结论 (建议申购/谨慎/放弃)
- 破发预警 → 五维评分表 + 风险等级 + 可比公司估值对照
- 市值计算 → 分沪深两市分别计算，列出可打签数
- 上市跟踪 → 首日涨幅 + 开板日/换手率关键指标 + 走势判断
