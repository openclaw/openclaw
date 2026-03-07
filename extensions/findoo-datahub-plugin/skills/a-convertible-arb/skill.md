---
name: fin-a-convertible-arb
description: "A-share convertible bond (可转债) arbitrage & strategy — double-low screening, forced-redemption timing, conversion-price reset (下修) analysis, YTM debt-floor valuation, credit risk assessment. Uses fin_derivatives (convertible endpoints), fin_stock (underlying equity), fin_ta (technicals). Use when: user mentions 可转债/转债/CB, convertible bond codes (11xxxx.SH/12xxxx.SZ), double-low strategy (双低), forced redemption (强赎), conversion price reset (下修), or YTM analysis on Chinese convertible bonds. NOT for: futures/options (use fin-derivatives), plain A-share equity (use fin-a-share unless the question is about a CB's underlying), US/HK stocks (use fin-us-equity/fin-hk-stock), crypto (use fin-crypto)."
metadata: { "openclaw": { "emoji": "🔄", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# A-Share Convertible Bond Arbitrage (A股可转债策略)

Use **fin_derivatives** (convertible endpoints), **fin_stock** (underlying equity data), and **fin_ta** (technical indicators) for convertible bond analysis via DataHub.

## When to Use

- User mentions 可转债、转债、CB、可转换债券
- Convertible bond codes: `11xxxx.SH` (上交所) / `12xxxx.SZ` (深交所)
- Double-low screening (双低策略筛选)
- Forced redemption analysis (强赎博弈)
- Conversion price reset (下修转股价) analysis
- YTM (到期收益率) ranking or debt-floor valuation
- Credit risk assessment for convertible bonds
- T+0 intraday trading strategy on convertible bonds
- User asks about a specific CB's underlying stock (e.g. "XX转债正股怎么样") — this is still a CB context

## When NOT to Use

- Plain A-share stock analysis without CB context → use **fin-a-share**
- Futures or commodity options → use **fin-derivatives**
- US/HK equities → use **fin-us-equity** / **fin-hk-stock**
- Market-wide overview → use **fin-a-share-radar**
- ETF/fund analysis → use **fin-etf-fund**

## Tools & Parameters

### fin_derivatives (convertible endpoints)

| Parameter  | Type   | Required | Format             | Default | Example          |
| ---------- | ------ | -------- | ------------------ | ------- | ---------------- |
| symbol     | string | Yes      | CB code            | —       | 113050.SH        |
| endpoint   | string | Yes      | see endpoint table | —       | convertible/list |
| trade_date | string | No       | YYYY-MM-DD         | —       | 2026-03-07       |
| start_date | string | No       | YYYY-MM-DD         | —       | 2026-01-01       |
| end_date   | string | No       | YYYY-MM-DD         | —       | 2026-03-07       |
| limit      | number | No       | 1-5000             | 200     | 50               |

### fin_stock (underlying equity)

| Parameter | Type   | Required | Format             | Default | Example          |
| --------- | ------ | -------- | ------------------ | ------- | ---------------- |
| symbol    | string | Yes      | A-share code       | —       | 600519.SH        |
| endpoint  | string | Yes      | see endpoint table | —       | price/historical |

### fin_ta (technical indicators)

| Parameter | Type   | Required | Format      | Default | Example   |
| --------- | ------ | -------- | ----------- | ------- | --------- |
| symbol    | string | Yes      | CB or stock | —       | 113050.SH |
| endpoint  | string | Yes      | indicator   | —       | rsi       |

### Symbol Format

| Type            | Pattern     | Example              |
| --------------- | ----------- | -------------------- |
| 上交所可转债    | `11xxxx.SH` | 113050.SH (南银转债) |
| 深交所可转债    | `12xxxx.SZ` | 123136.SZ (绿动转债) |
| 正股 (Shanghai) | `600xxx.SH` | 600036.SH (招商银行) |
| 正股 (Shenzhen) | `000xxx.SZ` | 000001.SZ (平安银行) |

## Endpoint Map

### Convertible Bond Endpoints (fin_derivatives)

| endpoint                 | Description                      | Key Params                   |
| ------------------------ | -------------------------------- | ---------------------------- |
| `convertible/list`       | All CB list with basic info      | limit                        |
| `convertible/detail`     | Single CB detail (terms/clauses) | symbol                       |
| `convertible/historical` | CB historical OHLCV + premium    | symbol, start_date, end_date |

### Underlying Equity Endpoints (fin_stock)

| endpoint              | Description           | Key Params |
| --------------------- | --------------------- | ---------- |
| `price/historical`    | Underlying OHLCV      | symbol     |
| `fundamental/ratios`  | PE/PB/ROE etc.        | symbol     |
| `profile`             | Company overview      | symbol     |
| `shareholders/pledge` | Pledge ratio (质押率) | symbol     |
| `financial/cashflow`  | Cash flow statement   | symbol     |

### Technical Endpoints (fin_ta)

| endpoint    | Description     | Key Params |
| ----------- | --------------- | ---------- |
| `rsi`       | RSI(14)         | symbol     |
| `macd`      | MACD            | symbol     |
| `bollinger` | Bollinger Bands | symbol     |

---

## Analysis Patterns

### Pattern 1: 双低策略筛选 (Double-Low Screening)

**目标:** 找出"下有保底、上有弹性"的可转债组合。

1. 获取全市场可转债列表:
   `fin_derivatives(endpoint="convertible/list", limit=5000)`

2. 计算双低值:
   `双低值 = 转债价格 + 转股溢价率 × 100`

3. 筛选条件 (按优先级):
   - 双低值 < 130 (核心条件)
   - 剩余年限 > 1 年 (避免到期强制赎回)
   - 信用评级 >= AA- (避免信用风险)
   - 正股非 ST / \*ST (排除退市风险)
   - 日均成交额 > 500 万 (保证流动性)

4. 双低值分层解读:

| 双低值区间 | 评价     | 策略建议                     |
| ---------- | -------- | ---------------------------- |
| < 110      | 极度低估 | 重仓，等权持有 10-20 只      |
| 110 - 130  | 优质区间 | 标准仓位，月度轮动           |
| 130 - 150  | 中性     | 需额外催化剂 (下修/业绩改善) |
| > 150      | 偏贵     | 不适合双低策略               |

5. 组合构建: 取双低值最低的 10-20 只等权持有，每月末按最新双低值重新排序轮动。

> 💡 双低策略的超额收益来源于"均值回归"——低价+低溢价的转债要么正股反弹带动转债上涨，要么溢价率压缩（下修/强赎预期）。

> ⚠️ 双低值计算前务必剔除已公告强赎的转债（这些转债价格将向转股价值收敛，双低值失真）。

### Pattern 2: 强赎博弈分析 (Forced Redemption Timing)

**目标:** 识别即将触发或已触发强赎条款的转债，把握套利窗口。

1. 查询目标转债条款:
   `fin_derivatives(endpoint="convertible/detail", symbol="113050.SH")`
   → 提取强赎触发条件 (通常: 正股价连续 15/30 日 > 130% 转股价)

2. 获取正股历史价格:
   `fin_stock(endpoint="price/historical", symbol="<正股代码>", limit=30)`
   → 计算正股价/转股价比值，统计连续满足天数

3. 强赎状态分类:

| 状态               | 含义                     | 操作建议                          |
| ------------------ | ------------------------ | --------------------------------- |
| 未触发 (< 10日)    | 距离强赎较远             | 按常规策略持有                    |
| 接近触发 (10-14日) | 高概率触发，市场开始定价 | 关注正股走势，准备转股或卖出      |
| 已触发 (>= 15日)   | 等待公司公告             | 15-30 交易日套利窗口              |
| 公告强赎           | 确认赎回，倒计时开始     | 转股价值 > 赎回价则转股，否则卖出 |
| 公告不赎回         | 管理层释放继续持有信号   | 利好持有，溢价率可能扩大          |

4. 强赎套利逻辑:
   - 强赎公告后，转债价格将向转股价值收敛
   - 若转股价值 > 当前转债价格 → 买入转债 + 转股 + 卖出正股锁定差价
   - 若转债价格 > 转股价值 → 卖出转债 (溢价率将快速压缩)

> ⚠️ 强赎公告后最后交易日通常有 15-30 个交易日，但最后几天流动性急剧下降，应提前操作。

> 💡 "不赎回"公告是隐含利好——说明公司希望持有人继续持有转债而非转股稀释股权，通常正股有上涨预期。

### Pattern 3: 下修转股价分析 (Conversion Price Reset)

**目标:** 识别可能下修转股价的转债，捕捉溢价率瞬间压缩的套利机会。

1. 查询下修条款:
   `fin_derivatives(endpoint="convertible/detail", symbol="<转债代码>")`
   → 提取下修触发条件 (通常: 正股价连续 N 日 < 85% 转股价，各家条款不同)

2. 验证是否满足触发条件:
   `fin_stock(endpoint="price/historical", symbol="<正股代码>", limit=30)`
   → 计算正股价/转股价比值

3. 下修概率评估:

| 因素           | 利于下修                     | 不利于下修           |
| -------------- | ---------------------------- | -------------------- |
| 转债余额占比   | 余额大，公司有促转股动力     | 余额小，下修收益不大 |
| 回售压力       | 临近回售期，管理层被迫行动   | 距回售期远           |
| 大股东持仓     | 大股东持有转债，下修利好自己 | 大股东无持仓         |
| 股权稀释容忍度 | 总股本大，稀释比例小         | 小盘股，稀释影响大   |

4. 下修结果分类:

| 类型       | 含义                       | 影响                         |
| ---------- | -------------------------- | ---------------------------- |
| 下修到底   | 转股价下修至最新正股价附近 | 溢价率大幅压缩，转债价格飙升 |
| 下修不到位 | 转股价仅小幅下调           | 溢价率部分压缩，涨幅有限     |
| 拒绝下修   | 股东大会否决               | 利空，溢价率可能进一步扩大   |

> 💡 下修公告到股东大会表决通常需 15-20 个交易日，期间转债价格会逐步反映下修预期。

> ⚠️ 下修需经股东大会 2/3 以上同意，大股东投票意向是关键——提前查询大股东是否持有转债。

### Pattern 4: 到期收益率分析 (YTM Debt-Floor Valuation)

**目标:** 评估转债的债底保护强度，判断安全边际。

1. 获取转债基本信息:
   `fin_derivatives(endpoint="convertible/detail", symbol="<转债代码>")`
   → 提取: 面值(通常100)、票面利率(各年不同)、到期赎回价、剩余年限

2. 获取当前价格:
   `fin_derivatives(endpoint="convertible/historical", symbol="<转债代码>", limit=1)`

3. YTM 近似计算:
   `YTM ≈ (到期赎回价 + 累计利息 - 当前价格) / (当前价格 × 剩余年限) × 100%`

4. YTM 分层解读:

| YTM 区间 | 属性   | 含义                         |
| -------- | ------ | ---------------------------- |
| > 3%     | 强债底 | 即使正股归零，到期仍有正收益 |
| 1% - 3%  | 有债底 | 安全边际充足，适合保守投资者 |
| 0% - 1%  | 弱债底 | 勉强保本，需依赖转股价值     |
| -3% - 0% | 无债底 | 已偏股化，需要正股上涨支撑   |
| < -3%    | 纯投机 | 完全依赖股性，无安全边际     |

> ⚠️ YTM 计算假设发行人正常兑付——信用风险高的转债(评级 < AA-)即使 YTM 高也不安全。

> 💡 A 股转债利息税率 20%(个人投资者)，计算税后 YTM 更准确: 税后利息 = 票面利息 × 0.8。

### Pattern 5: 信用风险评估 (Credit Risk Assessment)

**目标:** 排除有违约风险的转债，避免"搜特转债"式踩雷。

1. 查询转债评级和正股信息:
   `fin_derivatives(endpoint="convertible/detail", symbol="<转债代码>")`
   `fin_stock(endpoint="profile", symbol="<正股代码>")`

2. 查询正股财务健康度:
   `fin_stock(endpoint="fundamental/ratios", symbol="<正股代码>")`
   `fin_stock(endpoint="financial/cashflow", symbol="<正股代码>")`
   `fin_stock(endpoint="shareholders/pledge", symbol="<正股代码>")`

3. 信用风险评分体系:

| 风险因子     | 低风险      | 中风险     | 高风险 (红线)      |
| ------------ | ----------- | ---------- | ------------------ |
| 信用评级     | >= AA       | AA-        | < AA- 或无评级     |
| 质押率       | < 20%       | 20% - 40%  | > 40%              |
| 经营现金流   | 连续 3 年正 | 间歇性为负 | 连续 2 年为负      |
| 正股市值     | > 100 亿    | 30-100 亿  | < 30 亿            |
| 是否 ST/\*ST | 否          | —          | 是 (一票否决)      |
| 审计意见     | 标准无保留  | 带强调事项 | 保留/否定/无法表示 |

4. 红线规则 (任一触发即排除):
   - 正股 ST / \*ST
   - 信用评级 < AA-
   - 质押率 > 50%
   - 连续 2 年经营现金流为负 + 净利润为负

> ⚠️ 搜特转债 (2022年首只违约) 暴雷前兆: AA 评级下调→正股连续亏损→质押率飙升→评级再下调→违约。评级变动是最重要的预警信号。

> 💡 银行转债 (如南银转债、苏银转债) 信用风险极低，但弹性也最小——适合稳健配置而非套利。

---

## A股可转债交易规则 (必知)

| 规则         | 详情                                                      |
| ------------ | --------------------------------------------------------- |
| 交易方式     | T+0 (当天买入可当天卖出)                                  |
| 涨跌幅限制   | 无涨跌幅限制 (但有临停规则)                               |
| 临停规则     | 涨跌 >= 20% 停牌 30 分钟; 涨跌 >= 30% 停牌至 14:57        |
| 转股期       | 发行后 6 个月可转股 (具体见募集说明书)                    |
| 强赎条款     | 正股价连续 N 日 > 130% 转股价 (通常 15/30 中的 15 日)     |
| 回售条款     | 正股价连续 N 日 < 70% 转股价，持有人可按面值+利息回售     |
| 下修条款     | 正股价连续 N 日 < 85% 转股价，公司可提议下修 (需股东大会) |
| 税收 (个人)  | 利息税 20%，资本利得免税                                  |
| 最小交易单位 | 10 张 (面值 1000 元)                                      |
| 交易时间     | 9:30-11:30, 13:00-15:00 (同正股)                          |

---

## Data Notes

- **convertible/list**: 返回全市场存续可转债，含价格、溢价率、评级等核心字段
- **convertible/detail**: 返回单只转债的强赎/回售/下修条款细节、转股价、到期赎回价
- **convertible/historical**: 返回转债历史行情(OHLCV)及转股溢价率序列
- **正股数据联动**: 转债分析通常需同时查询正股数据，使用 fin_stock 的 price/historical 和 fundamental/ratios
- **数据延迟**: 收盘后更新，日内交易需注意数据时效
- **评级更新**: 信用评级非实时，通常跟踪评级公告

## Response Guidelines

- 始终用中文回复，专业术语可保留英文 (YTM, T+0, Delta 等)
- 涉及具体转债时，同时展示转债代码和简称 (如 113050.SH 南银转债)
- 双低策略筛选结果以表格形式呈现，按双低值升序排列
- 强赎/下修分析必须注明条款触发条件的具体天数和比例
- 信用风险评估明确标注红线因子，给出"安全/谨慎/回避"三级结论
- YTM 计算同时给出税前和税后数值
- 任何涉及操作建议时必须附带风险提示
- T+0 特性相关问题要提醒临停规则 (20% 和 30% 阈值)
