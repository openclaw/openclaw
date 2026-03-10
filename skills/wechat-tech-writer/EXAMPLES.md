# wechat-tech-writer 使用示例

本文档提供了三个完整的使用示例，展示不同类型文章的创作流程和最佳实践。

---

## 示例1：技术新闻/资讯类文章

### 用户输入

```
写一篇关于VSCode更名为"开源人工智能代码编辑器"的文章，网友戏称应该叫vibe coding studio，探讨一下为何这么更名
```

### 执行流程

#### 第1步：理解需求

- **主题类型**：技术新闻/资讯 + 分析评论
- **核心角度**：VSCode的AI转型、vibe coding概念、更名背后的原因
- **目标读者**：开发者、科技爱好者

#### 第2步：搜索信息（3-5轮）

**第1轮 - 搜索官方信息**：

```
查询："VSCode更名 开源人工智能代码编辑器 2025"
查询："VSCode AI功能 Copilot 2025"
```

找到：VS Code官网标语变化、Copilot Chat开源公告

**第2轮 - 搜索vibe coding概念**：

```
查询："vibe coding VSCode网友评论"
查询："微软VSCode AI编辑器 开发者反应"
```

找到：vibe coding的定义、Andrej Karpathy的提出、开发者社区反应

**第3轮 - 搜索背景信息**：

```
查询："VSCode Copilot开源 Cursor竞争"
```

找到：与Cursor的竞争关系、微软开源策略

#### 第3步：抓取内容（2-3篇）

抓取了以下关键内容：

1. OSCHINA - 微软VS Code打造开源AI编辑器的报道
2. CSDN - VSCode变成开源AI编辑器的突发消息
3. VS Code官网 - 官方标语"The open source AI code editor"

提取要点：

- 微软5月19日宣布GitHub Copilot Chat开源（MIT许可证）
- VS Code官网标语确实是"The open source AI code editor"
- Vibe coding概念由Andrej Karpathy在2025年2月提出
- Cursor已有36万付费用户，ARR突破3亿美元
- 开发者反应两极：有赞有弹

#### 第4步：改写创作（2000-3000字）

**文章结构**：

1. 引子（150字）：引入"更名"话题和vibe coding studio梗
2. 什么是Vibe Coding（400字）：解释新概念，用盖房子比喻
3. VSCode的AI野心（600字）：介绍AI功能、Agent模式、免费策略
4. 为什么微软要开源（500字）：分析五大原因、Cursor竞争
5. "Vibe Coding Studio"梗的由来（300字）：解读网友调侃
6. 如何开始（300字）：提供上手指引和官方链接
7. 总结展望（200字）：编程范式转变的思考

**语言风格特点**：

- 使用类比："盖房子vs建筑师沟通"、"操作系统"
- 第二人称："你会发现"、"如果你也想体验"
- 短句为主，便于阅读
- 适当使用引号强调关键词

#### 第5步：生成封面图（强制）

**分析主题**：

- 关键词：VSCode、AI、编辑器转型、Vibe Coding
- 核心价值："从代码编辑器到氛围编程工作室"
- 目标情绪：好奇（"VSCode改名了？"）+ 新奇（AI编程新方式）

**选择配色**：科技创新类 → 蓝紫渐变 (#1a1f5c → #7c3aed)

**构建提示词**（基于模板1：AI类）：

```
A stunning, eye-catching cover image for VSCode AI transformation article.

Design: vibrant gradient background from deep blue (#1a1f5c) to electric purple (#7c3aed), with glowing particles floating throughout and subtle light effects creating depth.

Central visual elements (positioned behind text):
- 3D floating geometric cubes in glass morphism style, semi-transparent with frosted glass effect
- Each cube contains a glowing icon: VSCode logo, code brackets symbol, AI brain circuit pattern
- Cubes connected by luminous cyan (#06b6d4) energy lines creating a network visualization
- Soft particle system with small glowing dots scattered across the scene
- Light rays emanating from cubes with lens flare effects

Text layout (CRITICAL - all text centered both horizontally and vertically):
- CENTER of image: Large bold title 'VSCode × AI' in white, modern sans-serif font with subtle glow
- Directly below title in CENTER: Chinese subtitle '从代码编辑器到氛围编程工作室' in elegant font, slightly smaller, 90% opacity
IMPORTANT: All text must be centered in the MIDDLE of the image, not at top or bottom edges.

Visual effects:
- Bokeh depth of field effect in background
- Subtle vignette darkening at edges
- Glowing highlights on cube edges
- Professional color grading with high contrast
- Clean composition with breathing space around text

Style: ultra-modern, tech-forward, sci-fi inspired, professional, magazine-quality
Visual mood: innovative, powerful, intelligent, cutting-edge, transformative
Color palette: blue-purple gradient (#1a1f5c to #7c3aed) with cyan (#06b6d4) and white (#ffffff) accents

CRITICAL REQUIREMENTS:
- All Chinese text in simplified Chinese (简体中文)
- Chinese characters must be clear, readable, and accurate - NO garbled text
- Text positioned in CENTER (middle) of image both horizontally and vertically
- High quality, 16:9 aspect ratio
- Professional design suitable for tech article cover
```

**调用生成**：

```bash
python scripts/generate_image.py \
  --prompt "[上述提示词]" \
  --api gemini \
  --output cover.png
```

**验证质量**：
✅ 中文清晰：主标题"VSCode × AI"和副标题清晰可读
✅ 颜色鲜明：蓝紫渐变吸引眼球
✅ 视觉元素：代码窗口、AI神经网络、转换箭头都有
✅ 符合主题：一看就知道是AI编程相关

#### 第6步：内容配图（按需 - 本例不生成）

**判断**：

- 文章主要是新闻解读和概念科普
- 没有明确的性能数据对比
- 没有复杂的技术架构需要图解
- **决定**：不生成额外配图（仅封面图）

#### 第7步：输出文章

**输出文件**：

- `VSCode更名事件.md`（文章主文件，约3200字）
- `cover.png`（封面图，637KB）

**文章特色**：

- 标题吸引眼球：包含"更名"悬念和"vibe coding studio"梗
- 结构清晰：7个部分，每部分主题明确
- 通俗易懂：用生活化比喻解释技术概念
- 链接纯文本格式：`https://code.visualstudio.com/`（不是markdown超链接）
- 无额外章节：没有"参考资料"、"图片说明"等

### 关键学习点

1. **新闻类文章重在时效性和全面性**
   - 搜索最新信息（2025年）
   - 多角度呈现（官方、网友、竞品）
   - 提供背景知识（vibe coding概念）

2. **封面图要体现新闻性**
   - 使用"×"符号表示结合/对抗
   - 副标题点明核心转变
   - 科技感强但不过于严肃

3. **内容配图要克制**
   - 新闻资讯类通常不需要额外配图
   - 封面图已足够吸引注意

---

## 示例2：AI大模型介绍文章

### 用户输入

```
写一篇关于Claude Sonnet 4的文章
```

### 执行流程

#### 第1步：理解需求

- **主题类型**：AI大模型介绍
- **核心角度**：功能特点、使用场景、与竞品对比
- **目标读者**：AI用户、开发者、技术爱好者

#### 第2步：搜索信息（4-5轮）

**第1轮 - 官方信息**：

```
查询："Claude Sonnet 4 官方介绍"
查询："Claude Sonnet 4 Anthropic 发布"
```

**第2轮 - 功能特性**：

```
查询："Claude Sonnet 4 功能特性 能力"
查询："Claude Sonnet 4 多模态 代码"
```

**第3轮 - 性能评测**：

```
查询："Claude Sonnet 4 vs GPT-4 性能对比"
查询："Claude Sonnet 4 benchmark 评测"
```

**第4轮 - 使用案例**：

```
查询："Claude Sonnet 4 应用案例 实战"
```

#### 第3步：抓取内容（3-4篇）

抓取：

1. Anthropic官网 - Claude Sonnet 4产品页
2. 技术博客 - 详细评测文章
3. GitHub - API使用示例
4. 对比评测 - 与GPT-4/Gemini的性能数据

提取要点：

- 发布时间、模型规模、主要改进
- 核心能力：推理、代码、多模态、上下文窗口
- 性能数据：响应时间、准确率、成本
- 典型应用场景
- API使用方法

#### 第4步：改写创作

**文章结构**（推荐结构）：

1. 引子（150字）：用一个实际场景引入
2. Claude Sonnet 4是什么（400字）：模型定位、发布背景
3. 核心能力详解（800字）：
   - 超强推理能力（举例）
   - 代码理解和生成（举例）
   - 多模态理解（举例）
   - 200K上下文窗口（意义）
4. 与竞品对比（500字）：
   - vs GPT-4：推理 > 速度 <
   - vs Gemini Pro：成本 > 准确率 >
   - 配数据对比表格（或图表）
5. 典型应用场景（400字）：
   - 代码助手、内容创作、数据分析、客服
6. 如何开始使用（300字）：
   - API密钥获取、快速开始代码、定价
7. 总结（150字）：Claude Sonnet 4的价值和展望

**语言风格**：

- 用实际例子说明能力（不是空洞描述）
- 数据对比要客观（不过度吹捧）
- 技术术语要解释（如"推理能力"是什么意思）

#### 第5步：生成封面图

**主题分析**：

- 关键词：Claude、Sonnet 4、AI大模型、推理能力
- 核心价值："超越GPT-4的推理能力"或"最强AI助手"
- 目标情绪：震撼、兴奋、信任

**配色**：AI类 → 蓝紫渐变 + 金色点缀（体现高端）

**提示词**（基于模板1，定制化）：

```
A stunning, eye-catching cover image for Claude Sonnet 4 AI model article.

Design: vibrant gradient background from deep blue (#1a1f5c) to electric purple (#7c3aed), with golden glowing particles floating throughout and subtle light effects creating depth.

Central visual elements (positioned behind text):
- 3D floating geometric cubes in glass morphism style, semi-transparent with frosted glass effect
- Each cube contains a glowing icon: AI brain circuit pattern, neural network nodes, data stream symbols
- Cubes connected by luminous golden (#f59e0b) energy lines creating a network visualization
- Soft particle system with small glowing golden dots scattered across the scene
- Light rays emanating from cubes with lens flare effects

Text layout (CRITICAL - all text centered both horizontally and vertically):
- CENTER of image: Large bold title 'Claude Sonnet 4' in white, modern sans-serif font with subtle glow
- Directly below title in CENTER: Chinese subtitle '超越GPT-4的推理能力' in elegant font, golden (#f59e0b) color, 90% opacity
IMPORTANT: All text must be centered in the MIDDLE of the image, not at top or bottom edges.

Visual effects:
- Bokeh depth of field effect in background
- Subtle vignette darkening at edges
- Glowing highlights on cube edges
- Professional color grading with high contrast
- Clean composition with breathing space around text

Style: ultra-modern, tech-forward, sci-fi inspired, professional, magazine-quality, premium feel
Visual mood: innovative, powerful, intelligent, cutting-edge, transformative, revolutionary
Color palette: blue-purple gradient (#1a1f5c to #7c3aed) with golden (#f59e0b) and white (#ffffff) accents

CRITICAL REQUIREMENTS:
- All Chinese text in simplified Chinese (简体中文)
- Chinese characters must be clear, readable, and accurate - NO garbled text
- Text positioned in CENTER (middle) of image both horizontally and vertically
- High quality, 16:9 aspect ratio
- Professional design suitable for tech article cover
```

#### 第6步：内容配图（按需 - 生成1张性能对比图）

**判断**：文章中有多个模型的性能数据对比 → 生成性能对比图

**数据提取**：

- Claude Sonnet 4：响应时间 850ms
- GPT-4 Turbo：响应时间 1100ms
- Gemini Pro：响应时间 950ms

**提示词**（基于类型1：柱状图）：

```
A clean performance comparison chart for AI models response time.
Design: horizontal bar chart with 3 bars.
Style: minimalist, professional data visualization with gradient fills.
Color scheme: gradient from blue (#3b82f6) to purple (#7c3aed) for bars.
Elements:
- Y-axis: model names in Chinese (Claude Sonnet 4, GPT-4 Turbo, Gemini Pro)
- X-axis: response time in Chinese (响应时间 单位:毫秒)
- Bar labels: exact values: 850, 1100, 950
- Bars ordered from fastest to slowest (Claude at top)
Visual style: modern, clean, corporate presentation quality.
Background: white with subtle gradient.
All text in simplified Chinese, accurate and clear.
IMPORTANT: Use exact values 850, 1100, 950 milliseconds.
16:9 aspect ratio, high contrast for readability.
```

**生成**：

```bash
python scripts/generate_image.py \
  --prompt "[上述提示词]" \
  --api gemini \
  --output performance-comparison.png
```

#### 第7步：输出文章

**输出文件**：

- `Claude_Sonnet_4介绍.md`（约2800字）
- `cover.png`（封面图）
- `performance-comparison.png`（性能对比图）

**文章嵌入配图**：

```markdown
## 与竞品对比

在响应速度方面，Claude Sonnet 4表现出色。根据第三方评测数据，
Claude Sonnet 4的平均响应时间为850毫秒，比GPT-4 Turbo快23%，
比Gemini Pro快11%。

![性能对比图](performance-comparison.png)

_图：主流AI模型响应速度对比（单位：毫秒）_

除了速度优势，Claude Sonnet 4在推理准确率上也有显著提升...
```

### 关键学习点

1. **AI模型文章要平衡技术性和通俗性**
   - 技术特性要解释清楚（不是罗列参数）
   - 用实际例子说明能力
   - 对比要客观公正

2. **性能对比图很有价值**
   - 数据必须准确（来源可信）
   - 图表清晰（不超过5个对比项）
   - 紧跟相关文字段落

3. **封面图要体现"高端感"**
   - 使用金色点缀（体现premium）
   - 副标题突出核心优势
   - 视觉元素：AI大脑、神经网络

---

## 示例3：开发工具/框架介绍文章

### 用户输入

```
帮我研究并写一篇介绍LangChain的文章，用DALL-E生成图片
```

### 执行流程

#### 第1步：理解需求

- **主题类型**：开发框架介绍
- **核心角度**：核心功能、安装使用、应用案例
- **目标读者**：开发者（有一定技术基础）
- **特殊要求**：使用DALL-E API生成图片

#### 第2步：搜索信息（4轮）

**第1轮 - 官方资源**：

```
查询："LangChain GitHub"
查询："LangChain 官方文档"
```

**第2轮 - 技术教程**：

```
查询："LangChain 教程 入门"
查询："LangChain 核心概念"
```

**第3轮 - 应用案例**：

```
查询："LangChain 应用案例 实战"
查询："LangChain 项目示例"
```

**第4轮 - 生态和对比**：

```
查询："LangChain vs LlamaIndex"
```

#### 第3步：抓取内容（3-4篇）

抓取：

1. LangChain GitHub README
2. 官方文档Quick Start部分
3. 技术博客详细教程
4. 实战项目案例

提取要点：

- LangChain是什么：构建LLM应用的框架
- 核心组件：Chains、Agents、Memory、Tools
- 典型应用：聊天机器人、文档问答、数据分析
- 安装和快速开始代码
- 优势和局限

#### 第4步：改写创作

**文章结构**：

1. 引子（120字）：AI应用开发的痛点引入
2. LangChain是什么（350字）：用"搭积木"比喻解释框架概念
3. 核心组件详解（700字）：
   - Chains（链）：组合调用
   - Agents（代理）：自主决策
   - Memory（记忆）：上下文保持
   - Tools（工具）：外部能力
   - 每个组件配简单代码示例
4. 快速上手（400字）：
   - 安装步骤
   - Hello World示例
   - 常见问题
5. 典型应用场景（450字）：
   - 文档问答系统（实际案例）
   - 智能客服（实际案例）
   - 数据分析助手（实际案例）
6. 进阶资源（200字）：GitHub、文档、社区链接
7. 总结（150字）：LangChain的价值

**语言特色**：

- 用"搭积木"比喻贯穿全文
- 代码示例精简（每个不超过10行）
- 强调实用性（不是学术介绍）

#### 第5步：生成封面图（使用DALL-E）

**主题分析**：

- 关键词：LangChain、开发框架、链式调用、模块化
- 核心价值："像搭积木一样构建AI应用"
- 目标情绪：高效、简单、创新

**配色**：开发工具类 → 绿橙渐变 (#10b981 → #f97316)

**提示词**（基于模板2：工具类，定制化）：

```
A stunning, eye-catching cover image for LangChain framework tutorial article.

Design: vibrant gradient background from vibrant green (#10b981) to bright orange (#f97316), with glowing particles floating throughout and subtle light effects creating depth.

Central visual elements (positioned behind text):
- 3D floating modular blocks/cubes connected like chains in glass morphism style, semi-transparent with frosted glass effect
- Each cube contains a glowing icon: chain links, code brackets, API symbols, gear/cog icons
- Cubes connected by luminous cyan (#06b6d4) energy lines creating a modular architecture visualization
- Soft particle system with small glowing dots scattered across the scene
- Light rays emanating from cubes with lens flare effects

Text layout (CRITICAL - all text centered both horizontally and vertically):
- CENTER of image: Large bold title 'LangChain' in white, modern sans-serif font with subtle glow
- Directly below title in CENTER: Chinese subtitle '像搭积木一样构建AI应用' in elegant font, slightly smaller, 90% opacity
IMPORTANT: All text must be centered in the MIDDLE of the image, not at top or bottom edges.

Visual effects:
- Bokeh depth of field effect in background
- Subtle vignette darkening at edges
- Glowing highlights on cube edges
- Professional color grading with high contrast
- Clean composition with breathing space around text

Style: ultra-modern, developer-friendly, professional, magazine-quality, approachable yet powerful
Visual mood: efficient, modular, innovative, empowering, productive
Color palette: green-orange gradient (#10b981 to #f97316) with cyan (#06b6d4) and white (#ffffff) accents

CRITICAL REQUIREMENTS:
- All Chinese text in simplified Chinese (简体中文)
- Chinese characters must be clear, readable, and accurate - NO garbled text
- Text positioned in CENTER (middle) of image both horizontally and vertically
- High quality, 16:9 aspect ratio
- Professional design suitable for tech article cover
```

**调用DALL-E生成**：

```bash
python scripts/generate_image.py \
  --prompt "[上述提示词]" \
  --api dalle \
  --quality hd \
  --size 1792x1024 \
  --output cover.png
```

#### 第6步：内容配图（生成1张架构图）

**判断**：文章介绍了LangChain的四大核心组件及其关系 → 生成架构图

**提示词**（基于类型2：架构图）：

```
A modern technical architecture diagram for LangChain framework.
Design: layered architecture with 4 main components, connected by arrows.
Components (as rounded rectangles, top to bottom):
- Tools (工具层): "搜索、计算、数据库" in Chinese
- Memory (记忆层): "对话历史、上下文" in Chinese
- Chains (链式层): "组合调用、工作流" in Chinese
- Agents (代理层): "自主决策、任务规划" in Chinese
Visual elements:
- Arrows showing data flow (bottom to top: input, top to bottom: output)
- Color coding: each layer has distinct color (green, blue, orange, purple)
- Small icons for each component (database, brain, chain link, robot)
- Chinese labels on arrows (数据流, API调用)
Style: flat design with subtle shadows, modern, clean, developer-friendly.
Background: white with subtle gradient.
All text in simplified Chinese, clear labels.
16:9 aspect ratio, professional quality.
```

**生成**：

```bash
python scripts/generate_image.py \
  --prompt "[上述提示词]" \
  --api dalle \
  --output architecture.png
```

#### 第7步：输出文章

**输出文件**：

- `LangChain框架介绍.md`（约2600字）
- `cover.png`（DALL-E生成）
- `architecture.png`（DALL-E生成）

**文章嵌入配图**：

```markdown
## 核心组件详解

LangChain的架构可以分为四个主要层次，每层负责不同的功能：

![LangChain架构图](architecture.png)

_图：LangChain四层架构示意_

让我们逐一了解每个组件：

### 1. Tools（工具层）

...
```

### 关键学习点

1. **开发工具文章要注重实用性**
   - 提供可运行的代码示例
   - 安装步骤要详细准确
   - 强调实际应用价值

2. **架构图帮助理解复杂系统**
   - 分层清晰（不超过4层）
   - 数据流向明确
   - 配色区分不同模块

3. **使用DALL-E的注意事项**
   - 添加 `--quality hd` 获得高清图
   - 指定 `--size 1792x1024` 确保16:9比例
   - DALL-E对中文支持较弱，可能需要多次生成

---

## 通用最佳实践总结

### 📋 所有文章类型的共同点

1. **搜索策略**：
   - 第1轮：官方信息（权威性）
   - 第2轮：技术细节（深度）
   - 第3轮：应用案例/对比评测（实用性）
   - 第4轮：补充和验证（完整性）

2. **改写原则**：
   - 用自己的语言（不照搬原文）
   - 用比喻帮助理解（盖房子、搭积木、建筑师）
   - 结构清晰（7部分结构）
   - 长度适中（2000-3000字）

3. **封面图生成**：
   - 必须生成（强制要求）
   - 选择合适的配色（AI类蓝紫、工具类绿橙）
   - 副标题点明核心价值
   - 验证中文清晰度

4. **内容配图决策**：
   - 新闻类：0张（仅封面）
   - 介绍类：0-1张（架构图或对比图）
   - 评测类：1-2张（性能对比、功能对比）

### 🎯 不同文章类型的差异

| 类型           | 重点           | 结构侧重            | 配图建议    |
| -------------- | -------------- | ------------------- | ----------- |
| **新闻资讯**   | 时效性、全面性 | 背景+事件+分析+展望 | 仅封面图    |
| **AI模型介绍** | 能力展示、对比 | 功能+性能+案例+上手 | 封面+性能图 |
| **开发工具**   | 实用性、上手   | 概念+组件+示例+应用 | 封面+架构图 |
| **概念科普**   | 易懂性、深度   | 定义+原理+应用+影响 | 封面+对比图 |
| **教程指南**   | 可操作性、详细 | 准备+步骤+实战+进阶 | 封面+流程图 |

### 💡 提升质量的技巧

1. **开头吸引人**：
   - 用实际场景引入（不是空洞介绍）
   - 第一段就要让读者感兴趣

2. **中间有干货**：
   - 每个部分都有具体例子
   - 数据要准确（标注来源）
   - 代码要能运行

3. **结尾有升华**：
   - 不只是总结，要有展望
   - 引发读者思考
   - 留下深刻印象

4. **通篇易读性**：
   - 段落不超过5行
   - 使用小标题分隔
   - 适当使用列表和表格
   - 避免长句（不超过25字）

---

## 快速参考：文章类型决策树

```
用户输入话题
    │
    ├─ 包含"最新"、"发布"、"更名" → 新闻资讯类
    │   └─ 搜索官方公告 + 社区反应
    │       └─ 生成封面图（新闻感）
    │           └─ 不生成内容配图
    │
    ├─ 是AI模型/工具名称 → 介绍类
    │   ├─ 是AI大模型 → AI模型介绍
    │   │   └─ 搜索功能+评测+案例
    │   │       └─ 生成封面图（高端感）
    │   │           └─ 可选：性能对比图
    │   │
    │   └─ 是开发工具 → 工具介绍
    │       └─ 搜索文档+教程+案例
    │           └─ 生成封面图（开发者友好）
    │               └─ 可选：架构图/流程图
    │
    └─ 是技术概念 → 概念科普
        └─ 搜索定义+原理+应用
            └─ 生成封面图（科普感）
                └─ 可选：概念对比图
```

---

**提示**：这些示例都是真实执行的流程，你可以参考这些模式来处理类似的任务！
