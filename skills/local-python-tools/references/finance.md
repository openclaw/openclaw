# 金融数据工具参考

## akshare

akshare 是免费金融数据接口，数据源为东方财富、同花顺等。

### 常用函数速查

```python
import akshare as ak

# === 股票 ===
ak.stock_zh_a_spot_em()              # A 股全市场实时行情（涨跌幅、成交量等）
ak.stock_zh_a_hist(symbol="000001", period="daily", start_date="20250101", end_date="20260321")  # 个股K线
ak.stock_zh_index_spot_em()          # 指数实时行情
ak.stock_board_industry_rank_em()    # 行业板块排行
ak.stock_hot_rank_em()               # 股票热度榜
ak.stock_zt_pool_em(date="20260321")  # 涨停股池
ak.stock_zt_pool_strong_em(date="20260321")  # 强势股池
ak.stock_lhb_detail_em(date="20260321")  # 龙虎榜明细
ak.stock_individual_info_em(symbol="000001")  # 个股基本信息

# === 基金 ===
ak.fund_open_fund_info_em(fund="000001", indicator="历史净值")  # 开放式基金净值
ak.fund_etf_hist_sina(symbol="sh510300")  # ETF K线

# === 期货 ===
ak.futures_zh_daily_sina(symbol="IF")  # 期货日线

# === 宏观 ===
ak.macro_china_money_supply()          # 货币供应量
ak.macro_china_cpi()                   # CPI 数据

# === 可转债 ===
ak.bond_zh_cov()                       # 可转债数据
```

### 数据保存

```python
df = ak.stock_zh_a_spot_em()
df.to_excel("C:\\Users\\Administrator\\Desktop\\market.xlsx", index=False)
df.to_csv("C:\\Users\\Administrator\\Desktop\\market.csv", index=False, encoding="utf-8-sig")
```

---

## tushare

tushare 需要注册获取 token（基础功能免费），数据质量高，适合基本面分析。

### 设置 Token

```python
import tushare as ts
ts.set_token("你的token")  # 一次性设置，存于用户目录
pro = ts.pro_api()
```

### 常用函数

```python
# 日线行情（支持不复权、前复权、后复权）
df = pro.daily(ts_code="000001.SZ", start_date="20250101", end_date="20260321")
df = pro.daily(ts_code="000001.SZ", start_date="20250101", end_date="20260321", adj="qfq")  # 前复权

# 上市公司基本信息
df = pro.stock_basic(exchange='', list_status='L')  # 在沪/深上市的全部A股

# 财务指标（roe、eps、pe等）
df = pro.fina_indicator(ts_code="000001.SZ", start_date="20250101")

# 利润表
df = pro.income(ts_code="000001.SZ", start_date="20250101")

# 资产负债表
df = pro.balancesheet(ts_code="000001.SZ", start_date="20250101")

# 现金流量表
df = pro.cashflow(ts_code="000001.SZ", start_date="20250101")

# 指数日线
df = pro.index_daily(ts_code="000001.SH")  # 上证指数

# 龙虎榜
df = pro.top_list(trade_date="20260321")

# 限售股解禁
df = pro.share_float(trade_date="20260321")
```

### 数据保存

```python
df.to_excel("C:\\Users\\Administrator\\Desktop\\financial.xlsx", index=False)
```

---

## pandas 数据处理

```python
import pandas as pd

# 读取
df = pd.read_excel("data.xlsx")
df = pd.read_csv("data.csv", encoding="utf-8-sig")

# 基本操作
df.info()
df.describe()
df.head(10)
df.tail(5)

# 筛选
df[df["涨跌幅"] > 9.9]          # 涨停股
df[df["市盈率"] < 20]           # 低估值

# 排序
df.sort_values("涨跌幅", ascending=False)

# 新增列
df["市值亿"] = df["总市值"] / 1e8

# 分组统计
df.groupby("行业")["涨跌幅"].mean()

# 导出
df.to_excel("result.xlsx", index=False)
df.to_csv("result.csv", index=False, encoding="utf-8-sig")
```
