# Findoo Skill 设计哲学与规范

> 本文档定义了 findoo-datahub-plugin 全部 skill.md 的设计标准。
> 目标：让每个 skill 达到 **全球顶尖金融专家 + Claude Skill 架构专家** 双重水准。

---

## 一、设计原则

### 1. Skill = LLM 的决策地图

Skill.md 不是写给人看的 API 文档，而是写给 **LLM 做路由决策** 的指令。
每一行都要回答一个问题：**"LLM 读到这句话后，能否做出正确的调用决策？"**

### 2. 精准路由 > 信息完备

- **description** 是 LLM 选择 skill 的**唯一依据**，必须包含 "Use when:" 和 "NOT for:"
- **When NOT to Use** 比 "When to Use" 更重要——它防止误调用
- 工具边界清晰：一个场景只归属一个 skill，不允许歧义

### 3. 金融智慧 > 工具列表

- Analysis Pattern 不是调用顺序表，是**分析逻辑链**
- 每步包含：为什么做 → 看什么 → 异常信号 → 下一步条件分支
- 体现专业判断：交叉验证、矛盾信号解读、风险提示

### 4. 引导 LLM 行为

- Response Guidelines 决定输出质量（数字格式、单位、对比基准）
- Data Notes 让 LLM 知道数据的局限性（延迟、更新频率、来源差异）
- 不写 Response Guidelines = 放弃对输出质量的控制

---

## 二、Skill.md 必需结构

```
---
name: <kebab-case-name>
description: "<功能概述>. Use when: <触发场景>. NOT for: <排除场景 + 替代 skill>."
metadata: { "openclaw": { "emoji": "<emoji>", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# <标题>

<1-2 句定位说明>

## When to Use
- <中文查询示例> / <English query>
- ...（5-8 个覆盖常见表达）

## When NOT to Use
- <排除场景 1> → use `/skill-name`
- <排除场景 2> → use `/skill-name`
- ...（列出所有相邻 skill 的边界）

## Tools & Parameters
### <tool_name>
| Parameter | Type | Required | Format | Default | Example |
|-----------|------|----------|--------|---------|---------|
| ... | ... | ... | ... | ... | ... |

### Endpoints
| endpoint | Description | Key Params |
|----------|-------------|------------|
| ... | ... | ... |

## <Domain> Analysis Pattern
1. **<步骤名>** `tool(endpoint)` — <为什么>
   - ⚠️ 如果 <异常信号> → <条件分支动作>
   - 💡 <交叉验证提示>
2. ...

## Data Notes
- <数据源>: <延迟/更新频率/限制>
- <注意事项>

## Response Guidelines
- <数字格式规范>
- <单位使用规则>
- <对比基准要求>
- <表格/可视化建议>
- <必须注明的信息>
```

---

## 三、description 写法规范

### 模式

```
"<功能一句话>. Use when: <3-5 个触发场景>. NOT for: <排除场景 (use <替代 skill>)>."
```

### 正确示例

```yaml
description: "Equity research — A/HK/US stock prices, financials, money flow, ownership, dividends, index/ETF. Use when: user asks about stock quotes, company analysis, financial statements, or sector ETFs. NOT for: macro data (use fin-macro), crypto (use fin-crypto-defi), derivatives (use fin-derivatives), market-wide radar (use fin-market-radar)."
```

### 错误示例

```yaml
# 太笼统，LLM 无法区分
description: "Financial data query tool"

# 缺 "Use when:" 和 "NOT for:"
description: "Equity research — A-share, HK, US stock analysis, financials, money flow."

# 过长（> 300 字符），LLM 在大列表中会截断
description: "Equity research tool that supports A-share Shanghai and Shenzhen stocks, Hong Kong stocks, US stocks, including historical prices, income statements, balance sheets, cash flow statements, financial ratios, dividends, top 10 holders, money flow tracking, gainers and losers discovery, index constituents, ETF data, fund manager info, thematic indices, and Stock Connect northbound/southbound flows."
```

### 长度指引

- 理想：150-250 字符
- 上限：300 字符
- "Use when:" 部分用逗号分隔的短语，不要完整句子

---

## 四、"When NOT to Use" 写法规范

### 原则

- **每个相邻 skill 都要提到**，明确边界
- 用 `→ use /skill-name` 格式指向替代
- 不需要穷举，聚焦高频混淆场景

### 模板

```markdown
## When NOT to Use

- 宏观经济数据 (GDP/CPI/利率) → use `/fin-macro`
- 加密货币/DeFi 数据 → use `/fin-crypto-defi`
- 期货/期权/可转债 → use `/fin-derivatives`
- 全市场雷达 (龙虎榜/涨停/资金流) → use `/fin-market-radar`
- 通用 endpoint 查询 → use `/fin-data-query`
```

---

## 五、Analysis Pattern 写法规范

### 反面教材（工具列表式）

```
1. fin_stock(price/historical) — price trend
2. fin_stock(fundamental/income) — profitability
3. fin_stock(fundamental/cash) — cash quality
```

### 正面教材（金融智慧式）

```markdown
## Deep Analysis Pattern

1. **价格趋势** `fin_stock(price/historical)` — 先看走势全貌，确认趋势方向
2. **盈利质量** `fin_stock(fundamental/income)` — 营收和净利润趋势
   - ⚠️ 如果净利增速 < 营收增速 → 毛利率可能在收缩，查 fundamental/ratios
   - ⚠️ 如果连续 2 季度净利下滑 → 高风险信号
3. **现金验证** `fin_stock(fundamental/cash)` — OCF vs 净利润
   - ⚠️ 如果 OCF/NetIncome < 0.8 → 利润质量存疑，可能存在应收账款堆积
   - 💡 此处与 step 2 交叉验证：利润增但现金差 = 典型的"纸面利润"
4. **资金博弈** `fin_stock(moneyflow/individual)` — 主力资金流向
5. **筹码结构** `fin_stock(ownership/top10_holders)` — 机构增减持
   - 💡 结合 step 4：资金净流出但股东增持 → 可能是洗盘而非出逃
6. **宏观背景** → 切换到 `/fin-macro` 查行业相关宏观指标
```

### 关键要素

| 要素          | 符号 | 用途                        |
| ------------- | ---- | --------------------------- |
| 异常信号      | ⚠️   | 如果出现 X → 执行 Y         |
| 交叉验证      | 💡   | 两个数据源的逻辑关联        |
| 跨 skill 联动 | →    | 切换到其他 skill 获取上下文 |
| 判断阈值      | 数值 | 给 LLM 可量化的判断标准     |

---

## 六、Response Guidelines 写法规范

### 金融数据的格式标准

```markdown
## Response Guidelines

### 数字格式

- 股价: ¥1,528.00 / $192.53 / HK$388.60（保留 2 位小数）
- 市值/营收/利润: > 1 亿用"亿元"，< 1 亿用"万元"
- 涨跌幅: +2.35% / -1.08%（始终带 +/- 符号）
- PE/PB: 附带行业中位数对比（如 "PE 35.2x vs 行业 28.1x"）
- Crypto: BTC 到个位 ($67,432)，山寨币保留 4 位 ($0.0034)
- TVL/Volume: 用 $B/$M 简写 ($4.2B)

### 必须包含

- 数据截止日期（"数据截至 2025-02-28"）
- 数据来源标注（涉及多源时）
- 同比/环比变化（有对比才有信息量）

### 展示方式

- 单只股票 → 分段叙述 + 关键指标高亮
- 多只对比 → 表格
- 趋势数据 → 简述方向 + 关键拐点，不要罗列原始数据
- 异常值 → 主动标注并给出可能原因
```

---

## 七、Data Notes 写法规范

每个 skill 必须注明数据的局限性，让 LLM 能诚实地告知用户。

```markdown
## Data Notes

- **A 股**: Tushare 提供，收盘后 ~18:00 更新，非实时行情
- **港股/美股**: yfinance 提供，约 15 分钟延迟
- **财报**: 季度更新（年报 4 月、中报 8 月、三季报 10 月）
- **CoinGecko**: 免费 API 有速率限制（~30 req/min），高频查询可能失败
- **DefiLlama**: 无认证，数据约 10 分钟刷新
- **WorldBank**: 年度数据，通常滞后 6-12 个月
- **Tushare vs yfinance**: 同一标的的历史价格可能因复权方式不同而略有差异
```

---

## 八、工具边界划分（findoo-datahub-plugin 内部）

| 用户场景                            | 归属 Skill                                     | 主工具           |
| ----------------------------------- | ---------------------------------------------- | ---------------- |
| 个股行情/财报/股东                  | fin-equity                                     | fin_stock        |
| 指数/ETF/基金                       | fin-equity                                     | fin_index        |
| 龙虎榜/涨停/大宗/融资/北向/全球指数 | fin-market-radar                               | fin_market       |
| GDP/CPI/PMI/利率/国债/WorldBank     | fin-macro                                      | fin_macro        |
| 期货/期权/可转债                    | fin-derivatives                                | fin_derivatives  |
| CEX 行情/CoinGecko/DeFi             | fin-crypto-defi                                | fin_crypto       |
| OHLCV K 线（任何市场）              | fin-crypto-defi (crypto) / fin-equity (equity) | fin_data_ohlcv   |
| 市场 Regime 检测                    | 内部使用，不直接暴露为 skill                   | fin_data_regime  |
| 172 endpoint 通用查询               | fin-data-query                                 | fin_query        |
| 支持的市场列表                      | fin-data-query                                 | fin_data_markets |

### 关键边界决策

1. **北向资金归 market-radar**（不归 equity）— 因为它是全市场维度的监控数据
2. **fin_data_ohlcv 不单独建 skill** — 它是 equity 和 crypto-defi 的子能力
3. **fin_data_regime / fin_data_markets 归 data-query** — 它们是基础设施工具

---

## 九、验证清单

提交新 skill 或修改现有 skill 前，逐项检查：

- [ ] `description` 包含 "Use when:" 和 "NOT for:"
- [ ] `description` 长度 150-300 字符
- [ ] 有 "When to Use" 段落（5-8 个中英双语示例）
- [ ] 有 "When NOT to Use" 段落（覆盖所有相邻 skill）
- [ ] 有 "Response Guidelines" 段落
- [ ] 有 "Data Notes" 段落
- [ ] 参数表包含 Type / Required / Format / Default / Example
- [ ] Analysis Pattern 包含条件分支（⚠️）和交叉验证（💡）
- [ ] 工具边界不与其他 skill 重叠
- [ ] 前置元数据 `metadata` 为单行 JSON
- [ ] 文件大小 < 256KB

---

## 十、参考资源

- OpenClaw skill 规范: `docs/tools/skills.md`, `docs/tools/creating-skills.md`
- Skill 加载源码: `src/agents/skills/workspace.ts`
- 类型定义: `src/agents/skills/types.ts`
- 前置元数据解析: `src/markdown/frontmatter.ts`
