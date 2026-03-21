# Office 文档工具参考

## python-pptx

生成和编辑 PowerPoint（.pptx）文件。

### 基础用法

```python
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
import datetime

prs = Presentation()
prs.slide_width  = Inches(13.33)  # 16:9 宽屏
prs.slide_height = Inches(7.5)
```

### 幻灯片操作

```python
# 添加空白幻灯片
slide = prs.slides.add_slide(prs.slide_layouts[6])

# 添加标题文本框
title_box = slide.shapes.add_textbox(Inches(0.5), Inches(0.3), Inches(12), Inches(1))
tf = title_box.text_frame
tf.text = "报告标题"
p = tf.paragraphs[0]
p.font.size  = Pt(44)
p.font.bold  = True
p.font.color.rgb = RGBColor(0, 51, 102)
p.alignment  = PP_ALIGN.CENTER

# 添加正文
body_box = slide.shapes.add_textbox(Inches(0.5), Inches(1.5), Inches(12), Inches(5))
tf = body_box.text_frame
tf.word_wrap = True
p = tf.paragraphs[0]
p.text = "第一段正文内容"
p.font.size = Pt(18)
p.level = 0

# 添加第二段（自动在 tf 下新建 paragraph）
p2 = tf.add_paragraph()
p2.text = "第二段内容"
p2.font.size = Pt(16)
p2.level = 1  # 二级缩进
```

### 插入图片

```python
slide.shapes.add_picture("chart.png", Inches(0.5), Inches(2), width=Inches(6))
```

### 插入表格

```python
data = [
    ["股票代码", "股票名称", "涨跌幅", "市值(亿)"],
    ["000001", "平安银行", "3.25%", "1980.5"],
    ["600519", "贵州茅台", "-1.20%", "18600"],
]
rows, cols = len(data), len(data[0])
table = slide.shapes.add_table(rows, cols, Inches(0.5), Inches(3), Inches(12), Inches(2)).table

for i, row in enumerate(data):
    for j, cell in enumerate(row):
        table.cell(i, j).text = cell
        # 设置首行样式
        if i == 0:
            table.cell(i, j).text_frame.paragraphs[0].font.bold = True
            table.cell(i, j).text_frame.paragraphs[0].font.color.rgb = RGBColor(255, 255, 255)
```

### 保存

```python
output_path = "C:\\Users\\Administrator\\Desktop\\report.pptx"
prs.save(output_path)
print(f"PPT 已保存: {output_path}")
```

---

## python-docx

生成和编辑 Word（.docx）文件。

### 基础用法

```python
from docx import Document
from docx.shared import Pt, RGBColor, Inches, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

doc = Document()
```

### 标题和段落

```python
# 标题（1-9级）
doc.add_heading("一级标题", level=1)
doc.add_heading("二级标题", level=2)

# 正文段落
p = doc.add_paragraph("这是一段正文内容。")
p.alignment = WD_ALIGN_PARAGRAPH.LEFT
p.runs[0].font.size = Pt(12)

# 带格式的段落
p = doc.add_paragraph()
run = p.add_run("加粗")
run.bold = True
run.font.size = Pt(12)
p.add_run(" 和 ")
run2 = p.add_run("红色斜体")
run2.bold = True
run2.italic = True
run2.font.color.rgb = RGBColor(255, 0, 0)
```

### 插入图片

```python
doc.add_picture("chart.png", width=Inches(5))
doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
```

### 表格

```python
table = doc.add_table(rows=3, cols=3)
table.style = "Light Grid Accent 1"
data = [["A", "B", "C"], ["D", "E", "F"], ["G", "H", "I"]]
for i, row_data in enumerate(data):
    row = table.rows[i]
    for j, cell_text in enumerate(row_data):
        row.cells[j].text = cell_text
```

### 保存

```python
output_path = "C:\\Users\\Administrator\\Desktop\\report.docx"
doc.save(output_path)
print(f"Word 已保存: {output_path}")
```

---

## openpyxl

读写 Excel（.xlsx），支持读取现有文件、写入公式和样式。

### 读取

```python
from openpyxl import load_workbook

wb = load_workbook("input.xlsx")
ws = wb.active
print(ws["A1"].value)

# 遍历
for row in ws.iter_rows(min_row=1, max_row=10, values_only=True):
    print(row)
```

### 写入

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

wb = Workbook()
ws = wb.active
ws.title = "数据"

# 写入表头
ws["A1"] = "股票代码"
ws["B1"] = "涨跌幅"
ws["A1"].font = Font(bold=True, color="FFFFFF")
ws["A1"].fill = PatternFill("solid", fgColor="366092")

# 写入数据
data = [("000001", "3.25%"), ("600519", "-1.20%")]
for i, (code, chg) in enumerate(data, start=2):
    ws.cell(i, 1, code)
    ws.cell(i, 2, chg)

# 设置列宽
ws.column_dimensions["A"].width = 15
ws.column_dimensions["B"].width = 12

wb.save("output.xlsx")
```

---

## xlsxwriter

高性能写入，擅长图表和格式化输出（不支持读取）。

```python
import xlsxwriter

wb = xlsxwriter.Workbook("chart.xlsx")
ws = wb.add_worksheet("数据")

# 格式
bold = wb.add_format({"bold": True})
money = wb.add_format({"num_format": "¥#,##0"})
pct = wb.add_format({"num_format": "0.00%"})

# 写入
ws.write(0, 0, "月份", bold)
ws.write_column("A2", ["1月","2月","3月","4月","5月"])
ws.write_column("B2", [100, 120, 115, 130, 140])

# 图表
chart = wb.add_chart({"type": "column"})
chart.add_series({
    "values": "=数据!$B$2:$B$5",
    "categories": "=数据!$A$2:$A$5",
    "name": "销售额",
})
ws.insert_chart("D2", chart)

wb.close()
```
