# 内容配图生成指南

> **核心原则**：宁缺毋滥，质量优于数量。只在真正需要时才生成内容配图（0-2张）。

---

## 一、判断是否需要内容配图

### 决策流程图

```
┌─────────────────────┐
│  阅读文章正文内容     │
└──────────┬──────────┘
           │
    ┌──────▼──────┐
    │ 是否有明确的 │
    │  数据对比？  │
    └──┬───────┬──┘
       │       │
      是       否
       │       │
    生成对比图  │
       │    ┌──▼──────┐
       │    │是否有复杂│
       │    │技术架构？│
       │    └──┬───┬──┘
       │       │   │
       │      是   否
       │       │   │
       │    生成   │
       │   架构图  │
       │       │   │
    ┌──▼───────▼───▼─┐
    │  其他情况一律   │
    │    不生成配图    │
    └─────────────────┘
```

### 生成内容配图的典型场景

#### 场景1：性能/数据对比

**何时生成**：

- 文章中提到多个产品/模型的性能数据
- 有明确的指标对比（速度、准确率、成本等）
- 数字较多，纯文字不够直观

**示例触发条件**：

```markdown
# 文章中出现类似内容

"Claude Sonnet 4在推理速度上比GPT-4快30%，比Gemini Pro快15%..."
"VSCode的启动时间从2.3秒降至0.8秒..."
"Cursor的用户满意度达到92%，而VSCode为87%..."
```

**生成内容**：横向对比柱状图、雷达图、性能曲线图

#### 场景2：技术架构说明

**何时生成**：

- 介绍系统架构、框架设计
- 解释复杂的数据流向、调用关系
- 说明多层次的技术栈

**示例触发条件**：

```markdown
# 文章中出现类似内容

"VSCode的AI功能分为三层：UI层、Agent层、模型层..."
"数据处理流程：采集 → 清洗 → 转换 → 加载..."
"微服务架构包括：API网关、服务注册中心、配置中心..."
```

**生成内容**：架构示意图、流程图、层次结构图

#### 场景3：概念对比/前后差异

**何时生成**：

- 对比新旧两种方式
- 解释范式转变
- 说明升级带来的变化

**示例触发条件**：

```markdown
# 文章中出现类似内容

"传统编程 vs Vibe Coding"
"手动配置 vs 自动化配置"
"单体应用 vs 微服务架构"
```

**生成内容**：左右对比图、before/after图

### 不应该生成配图的情况

❌ **不要生成的场景**：

1. **装饰性配图**
   - 仅为美观，不传达信息
   - 通用的科技插画、人物剪影
   - 与内容关系不大的背景图

2. **重复性配图**
   - 已有封面图表达了相同主题
   - 与文字描述完全一致，没有额外信息

3. **简单文字可说清的内容**
   - 简单列表（3-5项）用文字更清晰
   - 单一步骤流程
   - 仅有1-2个数据点

4. **场景插画**
   - "一个人在电脑前工作"
   - "团队开会讨论"
   - "未来城市科技场景"

### 配图数量控制

| 文章类型     | 封面图      | 内容配图 | 总计  | 说明                       |
| ------------ | ----------- | -------- | ----- | -------------------------- |
| **产品评测** | 1张（强制） | 0-2张    | 1-3张 | 性能对比图、功能对比图     |
| **技术解析** | 1张（强制） | 0-2张    | 1-3张 | 架构图、流程图             |
| **新闻资讯** | 1张（强制） | 0张      | 1张   | 新闻类不需要内容配图       |
| **教程指南** | 1张（强制） | 0-1张    | 1-2张 | 流程图（可选），步骤用文字 |
| **概念科普** | 1张（强制） | 0-1张    | 1-2张 | 概念对比图（可选）         |

**关键原则**：内容配图总数不超过2张（封面图除外）

---

## 二、内容配图的类型和提示词

### 类型1：性能对比柱状图

**适用场景**：对比3-5个产品/模型的性能指标

**提示词模板**：

```
A clean performance comparison chart for [主题].
Design: horizontal bar chart with 3-4 bars, each representing a different [产品/模型].
Style: minimalist, professional data visualization with gradient fills.
Color scheme: gradient from blue (#3b82f6) to purple (#7c3aed) for bars.
Elements:
- Y-axis: product names in simplified Chinese ([产品1], [产品2], [产品3])
- X-axis: performance metric in Chinese ([指标名称，如"响应速度(ms)"])
- Bar labels: exact values at the end of each bar
- Legend: simple and clear in Chinese
Visual style: modern, clean, corporate presentation quality.
Background: white or light gradient, not distracting.
All text in simplified Chinese, accurate and clear.
16:9 aspect ratio, high contrast for readability.
```

**变量填充示例**：

```
[主题] = "AI模型响应速度对比"
[产品1] = "Claude Sonnet 4"
[产品2] = "GPT-4 Turbo"
[产品3] = "Gemini Pro"
[指标名称] = "响应时间(秒)"
```

**设计要点**：

- 最慢的数据放最上方，最快的放最下方（或反之，保持一致）
- 使用渐变色而非纯色（更现代）
- 数值要清晰标注
- 避免3D效果（难以准确读数）

### 类型2：技术架构图

**适用场景**：展示系统分层、模块关系、数据流

**提示词模板**：

```
A modern technical architecture diagram for [系统名称].
Design: layered architecture with 3-4 tiers, connected by arrows showing data flow.
Style: clean, professional, developer-oriented.
Layers from top to bottom:
- [层级1]: [组件名称] - represented as rounded rectangles
- [层级2]: [组件名称] - represented as rounded rectangles
- [层级3]: [组件名称] - represented as rounded rectangles
Visual elements:
- Arrows showing data flow direction (with Chinese labels like "数据流", "API调用")
- Color coding: each layer has a distinct color (blue, green, orange)
- Icons: subtle tech icons for each component (API, database, UI)
Style: flat design with subtle shadows, modern and clean.
Background: light gradient, not distracting.
All text in simplified Chinese, clear labels.
16:9 aspect ratio, high quality.
```

**变量填充示例**：

```
[系统名称] = "VSCode AI架构"
[层级1] = "UI层：编辑器界面、Chat面板"
[层级2] = "Agent层：Copilot、任务执行器"
[层级3] = "模型层：Claude、GPT、Gemini"
```

**设计要点**：

- 从上到下或从左到右的清晰流向
- 每层用不同颜色区分
- 箭头明确标注数据流向
- 避免过于复杂（不超过10个模块）

### 类型3：概念对比图（左右对比）

**适用场景**：对比两种方式、新旧差异、优劣分析

**提示词模板**：

```
A clear comparison image showing [概念A] vs [概念B].
Layout: split screen design, left side for [概念A], right side for [概念B].
Design:
- Left side: [概念A的视觉表现，如"传统编程：一行行代码"]
  - Color: cooler tones (blue-gray) representing traditional/old
  - Visual: [具体视觉元素]
- Right side: [概念B的视觉表现，如"Vibe Coding：对话框和AI"]
  - Color: warmer/brighter tones (green-blue) representing modern/new
  - Visual: [具体视觉元素]
- Center: "VS" or arrow showing transformation
Text labels:
- Left: "[概念A名称]" in Chinese
- Right: "[概念B名称]" in Chinese
- Optional: key differences listed below each side in Chinese
Style: clean, modern, infographic-style, easy to understand.
All text in simplified Chinese, clear and readable.
16:9 aspect ratio.
```

**变量填充示例**：

```
[概念A] = "传统编程"
[概念A的视觉表现] = "code editor with lines of code, manual typing"
[概念B] = "Vibe Coding"
[概念B的视觉表现] = "chat interface with AI assistant, natural language commands"
```

**设计要点**：

- 左右明显区分（颜色、风格）
- 中间的VS或箭头醒目
- 关键差异点简洁列出（不超过5点）

### 类型4：流程图

**适用场景**：展示工作流程、数据处理步骤

**提示词模板**：

```
A modern workflow diagram for [流程名称].
Design: horizontal flow from left to right with 4-6 steps.
Steps:
1. [步骤1] - represented as rounded rectangle with icon
2. [步骤2] - represented as rounded rectangle with icon
3. [步骤3] - represented as rounded rectangle with icon
4. [步骤4] - represented as rounded rectangle with icon
Visual elements:
- Arrows connecting steps (left to right, bold and clear)
- Icons inside each step box (search, process, write, check)
- Color gradient: steps transition from blue to green across the flow
- Chinese labels inside and below each step
Style: clean, modern, professional process diagram.
Background: white or subtle gradient.
All text in simplified Chinese, clear and concise.
16:9 aspect ratio.
```

**设计要点**：

- 步骤数量：4-6步（不超过8步）
- 箭头清晰，流向明确
- 每步配一个图标增强识别性
- 颜色渐变显示进展

### 类型5：数据雷达图（多维对比）

**适用场景**：对比多个产品在多个维度的表现

**提示词模板**：

```
A professional radar chart comparing [对比主题].
Design: spider/radar chart with 5-6 dimensions, showing 2-3 products.
Dimensions (axes):
- [维度1，如"性能"]
- [维度2，如"易用性"]
- [维度3，如"成本"]
- [维度4，如"生态"]
- [维度5，如"扩展性"]
Products (lines):
- [产品1]: blue line (#3b82f6)
- [产品2]: purple line (#7c3aed)
- [产品3]: green line (#10b981)
Visual elements:
- Semi-transparent fill for each product
- Clear legend in Chinese
- Axis labels in Chinese
- Grid lines for reference (subtle)
Style: modern, professional, data visualization quality.
All text in simplified Chinese.
Square aspect ratio (1:1), high quality.
```

**设计要点**：

- 维度数：5-6个（太少失去意义，太多难以阅读）
- 产品数：2-3个（不超过4个）
- 使用半透明填充，多条线重叠时仍可见
- 每个维度的量表一致（如都是0-10分）

---

## 三、生成执行步骤

### 步骤1：从文章中提取数据

**数据收集清单**：

如果是对比图：

- [ ] 产品/模型名称（2-5个）
- [ ] 对比指标（响应时间、准确率、价格等）
- [ ] 具体数值（带单位）
- [ ] 数据来源（确保准确性）

如果是架构图：

- [ ] 系统名称
- [ ] 层级划分（2-4层）
- [ ] 每层的主要组件
- [ ] 组件间的关系和数据流向

如果是流程图：

- [ ] 流程名称
- [ ] 主要步骤（4-6步）
- [ ] 每步的简短描述
- [ ] 步骤顺序和依赖关系

### 步骤2：选择合适的图表类型

**决策矩阵**：

| 数据特征            | 推荐图表类型 | 原因             |
| ------------------- | ------------ | ---------------- |
| 2-5个产品，单一指标 | 横向柱状图   | 直观，易对比     |
| 2-3个产品，多维度   | 雷达图       | 全面展示优势劣势 |
| 分层结构            | 架构图       | 清晰显示层次关系 |
| 顺序步骤            | 流程图       | 强调先后顺序     |
| 新旧对比            | 左右对比图   | 突出差异         |

### 步骤3：构建提示词

**组装检查清单**：

- [ ] 选择了正确的模板
- [ ] 填充了所有变量（产品名、指标名等）
- [ ] 强调了中文要求
- [ ] 指定了配色方案
- [ ] 明确了图表类型（bar chart, architecture diagram等）
- [ ] 包含质量关键词（professional, clean, modern）

**提示词质量自检**：

1. 是否包含"simplified Chinese"至少2次？
2. 是否明确了颜色代码或配色方案？
3. 是否指定了具体的图表类型？
4. 是否限制了元素数量（避免过于复杂）？

### 步骤4：调用API生成

```bash
python scripts/generate_image.py \
  --prompt "你构建的完整提示词" \
  --api gemini \
  --output "输出路径/comparison.png"
```

**参数建议**：

- 对比图、流程图：使用16:9比例（`--aspect-ratio 16:9`）
- 雷达图、架构图：可使用1:1比例（更紧凑）

### 步骤5：验证和优化

**验证清单**：

- [ ] 数据准确（数值、名称与文章一致）
- [ ] 中文清晰（无乱码、可读）
- [ ] 视觉清晰（元素不重叠、对比度足够）
- [ ] 配色合理（与封面图风格协调）
- [ ] 传达信息明确（读者一眼能看懂）

**常见问题修复**：

| 问题     | 修复方法                                                                 |
| -------- | ------------------------------------------------------------------------ |
| 数据错误 | 重新生成，提示词中强调准确数据："exactly these values: A=90, B=85, C=78" |
| 文字太小 | 强调："large, readable labels"                                           |
| 颜色混乱 | 指定具体色彩代码："use only #3b82f6, #7c3aed, #10b981"                   |
| 太复杂   | 简化："show only 3 products, 4 metrics maximum"                          |

---

## 四、嵌入文章的最佳实践

### 嵌入位置

**原则**：图片应紧跟相关文字段落之后

**示例**：

```markdown
## VSCode与Cursor的性能对比

在响应速度方面，VSCode最新版本表现出色。根据测试数据，
VSCode的启动时间为0.8秒，比Cursor的1.2秒快33%。在代码
补全延迟方面，VSCode平均为150ms，而Cursor为180ms。

![性能对比图](performance-comparison.png)

_图：VSCode vs Cursor 性能对比_

从数据可以看出，VSCode在性能优化上已经赶上并超越了Cursor...
```

### 图注（Caption）规范

**格式**：

```markdown
![图片描述](image.png)

_图X：简短的图片说明_
```

**图注内容**：

- 简洁说明（不超过15字）
- 不重复图片中已有的信息
- 可选：数据来源

**示例**：

```markdown
✅ 好的图注
_图1：主流AI模型响应速度对比（单位：毫秒）_

❌ 不好的图注
_图1：这张图展示了Claude Sonnet 4、GPT-4和Gemini Pro三个模型在响应速度方面的详细对比，可以看出Claude最快_
（太啰嗦，信息已在图中）
```

### 文件命名规范

**命名模式**：`{类型}-{主题}.png`

**示例**：

```
performance-comparison.png    # 性能对比图
architecture-diagram.png      # 架构图
workflow.png                  # 流程图
before-after-comparison.png   # 前后对比图
```

**避免**：

```
image1.png              # 无意义的名称
图片_final_v2.png       # 混用中英文、版本号
```

### 图片大小控制

**目标**：

- 封面图：500-800KB
- 内容配图：200-500KB
- 总计：< 2MB

**过大时压缩**：

```bash
# 使用ImageMagick压缩（如果可用）
convert input.png -quality 85 -resize 1920x1080 output.png
```

---

## 五、高级技巧

### 技巧1：数据可视化颜色选择

**颜色语义**：

- 蓝色：稳定、可靠、专业（适合主导产品）
- 绿色：增长、正面、环保（适合性能提升）
- 橙色：警示、次要、中性（适合对比项）
- 红色：警告、减少、负面（慎用）
- 紫色：创新、高端、未来（适合新技术）

**对比配色方案**：

- 蓝 vs 紫：#3b82f6 vs #7c3aed（经典对比）
- 蓝 vs 绿：#3b82f6 vs #10b981（性能对比）
- 橙 vs 蓝：#f97316 vs #3b82f6（冷暖对比）

### 技巧2：确保数据准确性

**在提示词中嵌入精确数据**：

```
Create a bar chart with these EXACT values:
- Claude Sonnet 4: 850ms
- GPT-4 Turbo: 1100ms
- Gemini Pro: 950ms

IMPORTANT: Use these exact numbers, do not approximate.
```

**生成后验证**：

- 目测检查数值
- 如有误差，重新生成并强调精确性

### 技巧3：风格统一

**如果生成多张配图**：

- 使用相同的配色方案
- 使用一致的字体风格
- 保持相似的设计语言（扁平/3D、极简/丰富）

**示例提示词统一元素**：

```
Style consistency:
- Color palette: blue (#3b82f6), purple (#7c3aed), green (#10b981)
- Design: flat, modern, minimal
- Font: sans-serif, bold for titles
- Background: white with subtle gradient
```

### 技巧4：针对移动端优化

**考虑要素**：

- 文字大小：移动端阅读时文字要足够大
- 对比度：确保在小屏幕上仍可辨识
- 简化：移动端避免过于复杂的图表

**提示词调整**：

```
Design for mobile viewing:
- Large, bold labels (minimum 14pt equivalent)
- High contrast colors
- Simple layout with clear spacing
- Maximum 4 data points for clarity
```

---

## 六、常见问题

### Q1：何时该生成2张内容配图，何时只生成1张？

**答**：遵循"需求优先"原则：

- 如果文章有性能对比**和**架构说明，两者都很重要 → 生成2张
- 如果只有一个复杂点需要图解 → 生成1张
- 如果都是简单内容 → 0张

**经验法则**：如果你需要思考"要不要生成"，那就不生成。

### Q2：生成的图表数据与文章不符怎么办？

**答**：

1. 在提示词中用大写强调：`EXACT VALUES: A=85, B=90, C=78`
2. 重新生成2-3次，选择最准确的
3. 如仍不准确，考虑用文字列表代替图表

### Q3：生成的架构图太复杂，看不清？

**答**：简化策略：

- 减少层级（从4层减至3层）
- 合并同类组件（将多个微服务合并为"微服务集群"）
- 去除次要连接线（只保留主要数据流）
- 分两张图展示（一张总览，一张局部放大）

### Q4：如何判断配图是否真的有用？

**自测**：

- 遮住图片，只读文字 → 是否能理解？
  - 能理解 → 配图可能不必要
  - 难以理解 → 配图有价值
- 给非专业人士看图 → 是否秒懂？
  - 秒懂 → 好配图
  - 困惑 → 需要改进或删除

---

## 七、内容配图检查清单

### 生成前检查

- [ ] 确认真的需要这张配图（不是装饰）
- [ ] 选择了合适的图表类型
- [ ] 准备了准确的数据
- [ ] 配色与封面图协调

### 生成后检查

- [ ] 数据准确无误
- [ ] 中文清晰可读
- [ ] 视觉清晰不混乱
- [ ] 文件大小合理（< 500KB）
- [ ] 文件命名规范

### 嵌入文章后检查

- [ ] 位置紧跟相关段落
- [ ] 有恰当的图注
- [ ] 与文字内容呼应
- [ ] 在移动端可读

---

## 八、最佳实践总结

### ✅ 应该做的

1. **少而精** - 0-2张配图，每张都有明确作用
2. **数据准确** - 图表数据必须与文章一致
3. **风格统一** - 配图与封面图配色协调
4. **适时插入** - 紧跟相关文字段落
5. **移动友好** - 确保小屏幕可读

### ❌ 不应该做的

1. **为了配图而配图** - 没有信息价值的装饰图
2. **图表过于复杂** - 超过5个数据点或10个组件
3. **风格杂乱** - 每张图配色、风格完全不同
4. **数据错误** - 图表数值与文字不符
5. **文件过大** - 单张图超过1MB

### 📊 质量标准

**优秀内容配图**（满分10分）：

- 信息价值：4分（传达了文字难以表达的信息）
- 准确性：3分（数据、标签完全准确）
- 清晰度：2分（视觉清晰、易读）
- 风格协调：1分（与整体风格一致）

**及格线**：7分
**优秀线**：9分

---

**记住**：内容配图不是必需的，但如果生成，必须有价值、准确、清晰！
