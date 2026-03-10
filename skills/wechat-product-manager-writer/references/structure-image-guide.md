# 内容结构图生成指南

## 快速开始

每篇文章必须生成一张内容结构图，放在封面图之后。使用以下命令：

```bash
cd /root/.claude/skills/wechat-product-manager-writer

python scripts/generate_image.py \
  --prompt "你的提示词" \
  --api gemini \
  --output structure.png
```

---

## 风格说明

内容结构图采用**图形记录（Graphic Recording）/ 视觉思维（Visual Thinking）**风格：

| 元素 | 说明                               |
| ---- | ---------------------------------- |
| 背景 | 干净的白纸背景，无线条             |
| 线条 | 黑色细线笔，清晰轮廓               |
| 着色 | 彩色标记笔（青色、橙色、柔和红色） |
| 标题 | 3D 风格矩形框，居中放置            |
| 布局 | 放射状分布，用箭头连接想法         |
| 文字 | 手写大写字母印刷体                 |
| 比例 | 16:9                               |

---

## 提示词模板

### 通用模板

```
Create a hand-drawn sketch visual summary of these notes about [文章主题].

Key points to visualize:
- [要点1]
- [要点2]
- [要点3]
- [要点4]
- [要点5]

Use a clean white paper background (no lines).
Art style should be 'graphic recording' or 'visual thinking', using black fine-tip pen for clear outlines and text.
Use colored markers (especially cyan, orange, and soft red) for simple coloring and emphasis.
Place main title '[文章标题]' centered in a 3D-style rectangular box.
Surround the title with radially distributed simple doodles, business icons, stick figures, and diagrams to explain concepts.
Connect ideas with arrows.
Text should be clear, hand-written uppercase block letters.
Layout should be 16:9.
```

---

## 内容类型示例

### AI 产品拆解

```
Create a hand-drawn sketch visual summary of these notes about Cursor AI code editor analysis.

Key points to visualize:
- AI-powered code completion
- Context-aware suggestions
- Multi-file editing
- Natural language commands
- Pricing vs competitors

Use a clean white paper background (no lines).
Art style should be 'graphic recording' or 'visual thinking', using black fine-tip pen for clear outlines and text.
Use colored markers (especially cyan, orange, and soft red) for simple coloring and emphasis.
Place main title 'Cursor 产品拆解' centered in a 3D-style rectangular box.
Surround the title with radially distributed simple doodles, business icons, stick figures, and diagrams to explain concepts.
Connect ideas with arrows.
Text should be clear, hand-written uppercase block letters.
Layout should be 16:9.
```

### 场景解决方案

```
Create a hand-drawn sketch visual summary of these notes about building customer service chatbot with Dify.

Key points to visualize:
- Problem: manual customer support is slow
- Solution: AI chatbot with knowledge base
- Steps: create app, upload docs, configure workflow
- Results: 80% queries automated
- Tips: keep prompts simple

Use a clean white paper background (no lines).
Art style should be 'graphic recording' or 'visual thinking', using black fine-tip pen for clear outlines and text.
Use colored markers (especially cyan, orange, and soft red) for simple coloring and emphasis.
Place main title '用 Dify 搭建客服机器人' centered in a 3D-style rectangular box.
Surround the title with radially distributed simple doodles, business icons, stick figures, and diagrams to explain concepts.
Connect ideas with arrows.
Text should be clear, hand-written uppercase block letters.
Layout should be 16:9.
```

### 效率提升实战

```
Create a hand-drawn sketch visual summary of these notes about Claude Code workflow optimization.

Key points to visualize:
- Tip 1: Use project context
- Tip 2: Chain commands with &&
- Tip 3: Leverage slash commands
- Tip 4: Custom instructions
- Result: 3x faster coding

Use a clean white paper background (no lines).
Art style should be 'graphic recording' or 'visual thinking', using black fine-tip pen for clear outlines and text.
Use colored markers (especially cyan, orange, and soft red) for simple coloring and emphasis.
Place main title 'Claude Code 工作流优化' centered in a 3D-style rectangular box.
Surround the title with radially distributed simple doodles, business icons, stick figures, and diagrams to explain concepts.
Connect ideas with arrows.
Text should be clear, hand-written uppercase block letters.
Layout should be 16:9.
```

### 产品方法论

```
Create a hand-drawn sketch visual summary of these notes about AI Product Manager technical depth.

Key points to visualize:
- Core question: How technical should PM be?
- Level 1: Understand concepts
- Level 2: Read documentation
- Level 3: Build prototypes
- Balance: Enough to communicate, not to code

Use a clean white paper background (no lines).
Art style should be 'graphic recording' or 'visual thinking', using black fine-tip pen for clear outlines and text.
Use colored markers (especially cyan, orange, and soft red) for simple coloring and emphasis.
Place main title 'AI 产品经理的技术深度' centered in a 3D-style rectangular box.
Surround the title with radially distributed simple doodles, business icons, stick figures, and diagrams to explain concepts.
Connect ideas with arrows.
Text should be clear, hand-written uppercase block letters.
Layout should be 16:9.
```

### 行业观察

```
Create a hand-drawn sketch visual summary of these notes about whether Agent is necessary.

Key points to visualize:
- Hype vs Reality
- 90% scenarios don't need Agent
- When Agent helps: complex multi-step tasks
- When simple prompts work: single-turn queries
- My take: Start simple, add complexity when needed

Use a clean white paper background (no lines).
Art style should be 'graphic recording' or 'visual thinking', using black fine-tip pen for clear outlines and text.
Use colored markers (especially cyan, orange, and soft red) for simple coloring and emphasis.
Place main title 'Agent 真的有必要吗' centered in a 3D-style rectangular box.
Surround the title with radially distributed simple doodles, business icons, stick figures, and diagrams to explain concepts.
Connect ideas with arrows.
Text should be clear, hand-written uppercase block letters.
Layout should be 16:9.
```

---

## 内容要点提取流程

在生成结构图前，按以下步骤提取文章要点：

### 1. 核心主题（1句话）

> 这篇文章主要讲什么？

### 2. 主要观点（3-5个）

> 文章的核心论点或步骤是什么？

### 3. 关键概念关系

> 这些观点之间有什么联系？
>
> - 因果关系（A 导致 B）
> - 对比关系（A vs B）
> - 递进关系（1 → 2 → 3）
> - 并列关系（A、B、C 同等重要）

### 4. 核心结论

> 读者应该记住什么？采取什么行动？

---

## 视觉元素建议

| 概念类型  | 推荐图标/符号            |
| --------- | ------------------------ |
| 问题/痛点 | 问号、皱眉火柴人、红色X  |
| 解决方案  | 灯泡、绿色勾、工具图标   |
| 步骤/流程 | 数字、箭头、流程图       |
| 对比      | 天平、vs、左右分栏       |
| 结论      | 星星、重点标记、框线强调 |
| 工具/产品 | 简化 logo、电脑图标      |
| 人物      | 火柴人、简笔头像         |
| 数据      | 简单图表、上升箭头       |

---

## 质量检查

生成后确认：

- [ ] 标题清晰可读，放在中央
- [ ] 核心要点都已可视化
- [ ] 布局放射状，不杂乱
- [ ] 箭头连接合理
- [ ] 颜色使用恰当（青色、橙色、柔和红色）
- [ ] 整体手绘风格一致
- [ ] 16:9 比例正确

---

## 常见问题

**文字不清晰**：在提示词中强调 "Text should be clear, hand-written uppercase block letters"

**布局太乱**：减少要点数量，保持 3-5 个核心点

**颜色太杂**：强调 "especially cyan, orange, and soft red"，限制颜色种类

**风格不够手绘**：强调 "hand-drawn sketch"、"doodles"、"fine-tip pen"

**中文显示问题**：标题可以用中文，但要点描述建议用英文让AI更好理解，生成的图中会有视觉化表达
