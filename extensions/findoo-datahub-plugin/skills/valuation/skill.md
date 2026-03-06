---
name: fin-valuation
description: "Professional valuation — DCF, DDM, relative valuation (PE/PB bands), earnings forecast gap analysis. Adapted for A-share/HK/US markets. Use when: user asks about intrinsic value, target price, or valuation methods. NOT for: quick price checks (use fin-equity)."
metadata: { "openclaw": { "emoji": "💎", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Professional Valuation

专业估值分析。覆盖相对估值法、DCF 绝对估值法、DDM 股利折现法三大体系，针对 A 股/港股/美股市场特点分别调整。

## When to Use

- "茅台的内在价值是多少"
- "用 DCF 给宁德时代估值"
- "工商银行的 PB band 分析"
- "腾讯港股估值合理吗"
- "NVIDIA 的 DCF 估值"
- "高分红股票用 DDM 估值"
- "当前 PE 处于历史什么分位"

## When NOT to Use

- 快速查看股价/涨跌幅 → use `/fin-equity`
- 多因子筛选 → use `/fin-factor-screen`
- 行业/板块估值总览 → use `/fin-equity` (fin_index daily_basic)
- ETF/基金估值 → use `/fin-etf-fund`
- 宏观经济分析 → use `/fin-macro`

## 三大估值体系

### 体系一: 相对估值法 (Relative Valuation)

适用: 有可比公司、行业估值稳定的标的。

#### PE Band 分析

```
数据获取:
  fin_stock(symbol="600519.SH", endpoint="fundamental/ratios", limit=20)  # 近 5 年 PE
  fin_index(symbol="000300.SH", endpoint="daily_basic")                   # 指数 PE 参照

分析步骤:
  1. 计算近 5 年 PE 区间 [min, Q1, median, Q3, max]
  2. 当前 PE 在区间中的分位数
  3. 对比行业中位数 PE
  4. 判断: 低于 Q1 → 低估, 高于 Q3 → 高估
```

#### PB Band 分析

```
数据获取:
  fin_stock(symbol="601398.SH", endpoint="fundamental/ratios", limit=20)  # 近 5 年 PB

适用行业: 银行/保险/房地产/周期股 (资产密集型)
分析步骤:
  1. PB 区间 [min, Q1, median, Q3, max]
  2. ROE-PB 矩阵定位 (高 ROE + 低 PB = 价值洼地)
  3. 破净 (PB < 1) 需分析: 资产减值风险 vs 真低估
```

#### PE-G 分析 (PEG)

```
PEG = PE / 净利润增速 (%)

PEG < 0.5: 显著低估 (需确认增速可持续)
PEG 0.5-1.0: 合理偏低
PEG 1.0-1.5: 合理
PEG 1.5-2.0: 偏高
PEG > 2.0: 高估 (除非护城河极强)

数据获取:
  PE → fin_stock(endpoint="fundamental/ratios")
  增速 → fin_stock(endpoint="fundamental/income", limit=8) 计算 YoY
```

#### EV/EBITDA

```
适用: 资本密集型行业 (电信/公用事业/重工业)
优势: 消除资本结构和折旧政策差异

数据获取:
  fin_stock(endpoint="fundamental/metrics")   # EV, EBITDA
  fin_stock(endpoint="fundamental/balance")   # 净债务

EV = 市值 + 净债务
EV/EBITDA 行业参考:
  科技: 15-25x
  消费: 10-15x
  公用事业: 6-10x
  银行: 不适用 (用 PB)
```

### 体系二: DCF 绝对估值法 (Discounted Cash Flow)

适用: 现金流稳定可预测的成熟企业。

#### 数据收集

```
Step 1: 历史 FCF
  fin_stock(symbol="600519.SH", endpoint="fundamental/cash", limit=20)
  → 提取经营性现金流 (OCF) 和资本支出 (CapEx)
  → FCF = OCF - CapEx

Step 2: 收入增长率
  fin_stock(endpoint="fundamental/income", limit=20)
  → 近 5 年营收 CAGR

Step 3: 资本成本 (WACC)
  fin_stock(endpoint="fundamental/balance")    # 债务结构
  fin_stock(endpoint="fundamental/ratios")     # Beta
  fin_macro(endpoint="treasury_cn")              # 无风险利率 (10年国债)
```

#### WACC 计算

```
WACC = E/(E+D) × Re + D/(E+D) × Rd × (1-T)

Re = Rf + β × (Rm - Rf)

参数参考:
  Rf (无风险利率):
    A 股: 10 年国债收益率 (~2.5-3.0%)
    港股: 10 年美债 + 港元风险溢价 (~4.0-4.5%)
    美股: 10 年美债 (~4.0-4.5%)

  Rm - Rf (市场风险溢价):
    A 股: 6-7%
    港股: 5-6%
    美股: 5-6%

  β: 个股 Beta (通过历史收益率回归计算)
```

#### DCF 模型框架

```
预测期 FCF (5-10 年):
  Year 1-3: 基于近期增长趋势 + 行业判断
  Year 4-5: 逐步收敛至行业平均增速
  Year 6-10: 收敛至 GDP 增速 + 通胀

终值 (Terminal Value):
  TV = FCF_n × (1 + g) / (WACC - g)
  g (永续增长率): 2-3% (A 股), 2% (港美股)

内在价值:
  EV = Σ FCF_t / (1+WACC)^t + TV / (1+WACC)^n
  Equity Value = EV - Net Debt
  Per Share = Equity Value / Total Shares
```

#### 敏感性分析

| WACC ↓ / g → | 2.0% | 2.5% | 3.0% |
| ------------ | ---- | ---- | ---- |
| 8.0%         | ¥XXX | ¥XXX | ¥XXX |
| 9.0%         | ¥XXX | ¥XXX | ¥XXX |
| 10.0%        | ¥XXX | ¥XXX | ¥XXX |

### 体系三: DDM 股利折现法 (Dividend Discount Model)

适用: 高分红、股息稳定的蓝筹股。

#### Gordon Growth Model (单阶段)

```
V = D1 / (r - g)

D1 = 当前股息 × (1 + g)
r = 股权成本 (Re)
g = 股息增长率

数据获取:
  fin_stock(endpoint="fundamental/dividends", limit=10)  # 近 10 年分红记录
  → 计算分红 CAGR 作为 g
```

#### 两阶段 DDM

```
V = Σ D_t / (1+r)^t + D_n × (1+g2) / [(r-g2) × (1+r)^n]

高增长阶段 (5-10 年): g1 = 近期分红增速
稳定增长阶段: g2 = GDP 增速 (~2-3%)

适用: 增长期向成熟期过渡的企业
```

## A 股估值特殊考量

### 非经常性损益剔除

```
A 股公司常见非经常性项目:
  - 政府补助 (supplement)
  - 资产处置收益
  - 投资性收益 (炒股/理财)
  - 商誉减值

数据获取:
  fin_stock(endpoint="fundamental/income")
  → 扣非净利润 vs 归母净利润
  → 差异 > 20% 需特别标注
```

### 壳价值

```
A 股特有: 上市公司壳资源具有隐含价值
  - 2020 年前壳价值约 20-30 亿
  - 注册制改革后壳价值大幅缩水 (~5-10 亿)
  - 估值时: 小市值公司需考虑壳价值溢价是否合理
```

### 政府补助影响

```
部分行业严重依赖补贴:
  - 新能源: 补贴退坡影响估值
  - 芯片/半导体: 大基金投资影响
  - 农业: 农业补贴占利润比例

估值调整: 应基于扣补贴后的利润给估值
```

### A 股估值溢价因素

| 因素           | 溢价幅度 | 原因                 |
| -------------- | -------- | -------------------- |
| 稀缺性溢价     | 10-30%   | 行业龙头供给有限     |
| 流动性溢价     | 5-15%    | A 股散户多，流动性好 |
| 政策预期溢价   | 变动大   | 政策驱动型市场       |
| 北向资金定价权 | 逐步增强 | 外资偏好改变估值中枢 |

## 港股估值特殊考量

### AH 溢价分析

```
AH 溢价率 = A 股价格 / (H 股价格 × 汇率) - 1

数据获取:
  fin_stock(symbol="600519.SH", endpoint="price/historical")  # A 股
  fin_stock(symbol="00519.HK", endpoint="price/historical")   # H 股
  fin_macro(endpoint="currency/price/historical", symbol="USDCNH")  # 汇率

历史均值: AH 溢价约 30-40%
判断:
  溢价 > 50%: A 股偏贵，港股有吸引力
  溢价 < 20%: AH 估值趋近
```

### 港股流动性折价

```
港股流动性普遍低于 A 股:
  - 日均成交额 < 1000 万港元: 流动性折价 20-30%
  - 日均成交额 1000 万-1 亿: 流动性折价 10-15%
  - 日均成交额 > 1 亿: 无明显折价
```

### 港股股息税

```
内地个人投资者:
  - 港股通持股: 20% 红利税 (H 股), 20% (红筹股)
  - 直接投资: 10% (H 股), 0% (红筹股部分)

估值影响:
  DDM 中需扣除股息税后计算实际到手股息
  高息股税后股息率 = 税前股息率 × (1 - 税率)
```

## 美股估值参考

### 标准 DCF 适配

```
美股 DCF 参数参考:
  Rf: 10Y US Treasury (~4.0-4.5%)
  ERP: 5-6%
  β: S&P 500 为 1.0, 科技股 1.2-1.5
  g (终值): 2-2.5%
  WACC: 通常 8-12%

美股 PE 参考:
  S&P 500 历史均值: ~18x
  NASDAQ 100: ~25-30x
  Magnificent 7: 30-60x (增长溢价)
```

## 估值分析模板 (完整流程)

### Step 1: 数据收集 (并行)

```
fin_stock(endpoint="price/historical", limit=250)      # 股价走势
fin_stock(endpoint="fundamental/income", limit=20)      # 损益表 5 年
fin_stock(endpoint="fundamental/balance", limit=20)     # 资产负债表
fin_stock(endpoint="fundamental/cash", limit=20)        # 现金流量表
fin_stock(endpoint="fundamental/ratios", limit=20)      # 估值比率
fin_stock(endpoint="fundamental/dividends", limit=10)   # 分红历史
fin_stock(endpoint="fundamental/metrics", limit=8)      # 关键指标
```

### Step 2: 方法选择

| 条件                | 推荐方法         |
| ------------------- | ---------------- |
| 现金流稳定 + 可预测 | DCF              |
| 高分红 + 稳定增长   | DDM              |
| 有明确可比公司      | 相对估值 (PE/PB) |
| 周期股 / 亏损股     | PB + EV/EBITDA   |
| 高增长 + 无盈利     | PS + 用户价值    |

### Step 3: 多方法交叉验证

```
内在价值 = (DCF 估值 × 40% + 相对估值 × 40% + DDM × 20%)

安全边际:
  保守目标价 = 内在价值 × 0.8
  中性目标价 = 内在价值
  乐观目标价 = 内在价值 × 1.2
```

### Step 4: 与市场价对比

```
当前价 vs 内在价值:
  折价 > 30%: 显著低估 → 买入机会
  折价 10-30%: 适度低估 → 逐步建仓
  ±10%: 合理估值 → 持有
  溢价 10-30%: 适度高估 → 减仓
  溢价 > 30%: 显著高估 → 卖出/回避
```

## 估值陷阱识别

| 陷阱类型     | 表现              | 识别方法                      |
| ------------ | ----------------- | ----------------------------- |
| 价值陷阱     | PE 很低但持续下跌 | ROE 下降 + 行业衰退           |
| 成长陷阱     | 高增速但估值更高  | PEG > 2 + 增速减速            |
| 周期陷阱     | 周期底部 PE 极高  | 看 PB 而非 PE                 |
| 财务造假陷阱 | 财务数据太完美    | OCF 与净利严重背离 + 审计意见 |
| 壳价值陷阱   | 小市值看似低估    | 注册制后壳价值缩水            |

## 参考资料

- A 股估值详解: `references/valuation-cn.md`
- 财务比率指南: `references/financial-ratios-cn.md`

## Response Guidelines

- 估值结果必须给出区间 (保守/中性/乐观三档)
- DCF 必须附敏感性分析表 (WACC × g 矩阵)
- 相对估值附历史分位数 (5 年维度)
- 明确标注估值方法及关键假设
- 所有金额保留 2 位小数，标注货币单位
- 风险提示: 估值基于历史数据和假设，不构成投资建议
- 注明数据截止日期和使用的财报季度
- A/HK/US 市场需分别标注适用的参数
