---
name: local-python-tools
description: 本地 Python 第三方工具集成的 AI 辅助工作流。当用户需要以下操作时激活：(1) 获取股票、基金、期货、宏观等金融数据（akshare/tushare）；(2) 创建或编辑 Word、Excel、PowerPoint 文件（python-docx/python-pptx/openpyxl/xlsxwriter）；(3) 网页内容抓取、解析、提取（requests/beautifulsoup4/lxml/curl_cffi）；(4) 图片处理（裁剪、压缩、格式转换）；(5) 任何涉及 pandas 数据分析、JSON/表格处理的任务。直接在本地 Python 环境执行所有操作，无需调用外部付费 API。
---

# local-python-tools

本地 Python 工具集，覆盖金融数据获取、Office 文档生成、网页数据采集、图片处理四大场景。

## 环境依赖

所有工具已安装于 `C:\Users\Administrator\AppData\Local\Programs\Python\Python312\Lib\site-packages`，直接 `import` 即可：

```python
import akshare as ak          # 金融数据
import tushare as ts          # 财经数据
import pandas as pd           # 数据分析
import numpy as np             # 数值计算
import requests               # HTTP 请求
from bs4 import BeautifulSoup # 网页解析
import lxml                    # XML/HTML 引擎
from pptx import Presentation # PPT 生成
from docx import Document      # Word 生成
from openpyxl import load_workbook, Workbook  # Excel 读写
import xlsxwriter              # Excel 高性能写入
import xlrd                    # 旧版 Excel 读取
from PIL import Image          # 图片处理
```

> 注意：Windows 环境，命令行运行 Python 请用 `python`，非 `python3`。

---

## 场景一：金融数据获取

### akshare（实时/免费）

参考详细用法：`references/finance.md#akshare`

```python
# 实时行情
df = ak.stock_zh_a_spot_em()

# 个股历史 K 线
df = ak.stock_zh_a_hist(symbol="000001", period="daily", start_date="20250101", end_date="20260321")

# 指数行情
df = ak.stock_zh_index_spot_em()

# 龙虎榜
df = ak.stock_lhb_detail_em(date="20260321")

# 共同基金净值
df = ak.fund_open_fund_info_em(fund="000001", indicator="历史净值")
```

### tushare（基本面/需要 token）

参考详细用法：`references/finance.md#tushare`

```python
import tushare as ts
ts.set_token("你的token")  # 只需设置一次
pro = ts.pro_api()

# 日线行情
df = pro.daily(ts_code="000001.SZ", start_date="20250101", end_date="20260321")

# 上市公司基本信息
df = pro.stock_basic(exchange='', list_status='L')

# 财务指标
df = pro.fina_indicator(ts_code="000001.SZ", start_date="20250101")
```

---

## 场景二：Office 文档生成

### PowerPoint（python-pptx）

参考详细用法：`references/office.md#pptx`

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[6])  # 空白布局

# 添加标题
title = slide.shapes.add_textbox(Inches(0.5), Inches(0.3), Inches(9), Inches(0.8))
tf = title.text_frame
tf.text = "报告标题"
tf.paragraphs[0].font.size = Pt(32)
tf.paragraphs[0].font.bold = True

# 添加正文
body = slide.shapes.add_textbox(Inches(0.5), Inches(1.5), Inches(9), Inches(5))
tf = body.text_frame
tf.word_wrap = True
p = tf.paragraphs[0]
p.text = "这是正文内容"
p.font.size = Pt(18)

# 添加表格
rows, cols, data = 3, 3, [["A","B","C"],["D","E","F"],["G","H","I"]]
table = slide.shapes.add_table(rows, cols, Inches(0.5), Inches(3), Inches(9), Inches(1.5)).table
for i, row in enumerate(data):
    for j, cell in enumerate(row):
        table.cell(i, j).text = cell

prs.save("C:\\Users\\Administrator\\Desktop\\output.pptx")
```

### Word（python-docx）

参考详细用法：`references/office.md#docx`

```python
from docx import Document
from docx.shared import Pt, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()
doc.add_heading("文档标题", level=1)
doc.add_paragraph("正文内容", style="Normal")
doc.add_picture("image.png", width=Inches(4))
table = doc.add_table(rows=2, cols=3)
table.style = "Light Grid Accent 1"
doc.save("C:\\Users\\Administrator\\Desktop\\output.docx")
```

### Excel（openpyxl + xlsxwriter）

参考详细用法：`references/office.md#excel`

```python
# openpyxl：读取 + 写入（含公式样式）
from openpyxl import load_workbook
wb = load_workbook("input.xlsx")
ws = wb.active
ws["A1"] = "Hello"
wb.save("output.xlsx")

# xlsxwriter：高性能写入 + 图表
import xlsxwriter
wb = xlsxwriter.Workbook("output.xlsx")
ws = wb.add_worksheet("数据")
ws.write(0, 0, "标题")
chart = wb.add_chart({"type": "column"})
ws.write_column("A", [1,2,3,4,5])
chart.add_series({"values": "=Sheet1!$A$1:$A$5"})
ws.insert_chart("C1", chart)
wb.close()
```

---

## 场景三：网页数据采集

参考详细用法：`references/web.md`

```python
import requests
from bs4 import BeautifulSoup
import json

# 基础请求
headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
r = requests.get(url, headers=headers, timeout=10)

# 解析页面
soup = BeautifulSoup(r.content, "lxml")        # 用 lxml 引擎（快）
# soup = BeautifulSoup(r.content, "html5lib")  # 或 html5lib（容错强）

# 提取数据
titles = soup.select("h2.title")               # CSS 选择器
links  = [a["href"] for a in soup.find_all("a", href=True)]
text   = soup.get_text(strip=True)

# JSON 接口直接拿
data = r.json()

# curl_cffi：模拟浏览器绕过反爬
from curl_cffi import requests as creq
r = creq.get(url, impersonate="chrome")         # 模拟 Chrome
```

---

## 场景四：图片处理

参考详细用法：`references/image.md`

```python
from PIL import Image

# 打开
img = Image.open("input.png")

# 裁剪 (left, upper, right, lower)
cropped = img.crop((100, 100, 400, 400))

# 缩放
resized = img.resize((800, 600))

# 格式转换
img.convert("RGB").save("output.jpg")

# 压缩
img.save("compressed.jpg", quality=85, optimize=True)

# 添加文字水印（需 ImageDraw）
from PIL import ImageDraw, ImageFont
draw = ImageDraw.Draw(img)
draw.text((10, 10), "Watermark", fill=(255,255,255))
```

---

## 常用工具速查

| 任务 | 推荐工具 |
|------|---------|
| A 股实时行情 | `akshare stock_zh_a_spot_em` |
| K 线历史数据 | `akshare stock_zh_a_hist` |
| 财务报表 | `tushare pro.fina_indicator` |
| 生成 PPT | `python-pptx Presentation` |
| 生成 Word | `python-docx Document` |
| 读写 Excel | `openpyxl`（推荐）/ `xlrd`（读旧版）|
| 高速写 Excel | `xlsxwriter` |
| 发 HTTP 请求 | `requests` / `curl_cffi` |
| 解析 HTML | `BeautifulSoup(r.content, "lxml")` |
| 数据分析 | `pandas` + `numpy` |
| 图片裁剪压缩 | `PIL.Image` |
| 逆向 JS | `execjs` / `mini_racer` |

---

## 输出路径规范

- 桌面：`C:\Users\Administrator\Desktop\`
- 工作区：`C:\Users\Administrator\.openclaw\workspace\`
- 所有文件写入前确认路径存在，父目录不存在时自动创建。
