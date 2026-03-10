# 内容配图指南

## 核心原则

**宁缺毋滥**：只在真正需要时才生成内容配图（0-2 张）。

大多数产品经理文章**不需要**内容配图，封面图足够。

---

## 判断是否需要配图

```
阅读文章内容
  │
  ├─ 有明确数据对比？ → 是 → 生成对比图
  │
  ├─ 有复杂流程/架构？ → 是 → 生成流程图
  │
  └─ 其他情况 → 不生成配图
```

### 需要配图的场景

| 场景           | 配图类型 | 示例                   |
| -------------- | -------- | ---------------------- |
| 多产品性能对比 | 柱状图   | Claude vs GPT 响应速度 |
| 工具使用流程   | 流程图   | Dify 搭建步骤          |
| 方案架构       | 架构图   | RAG 系统结构           |

### 不需要配图的场景

- 产品方法论文章（观点为主）
- 行业观察文章（分析为主）
- 没有明确数据的产品拆解

---

## 配图类型和模板

### 1. 数据对比图

**适用**：有具体数字的产品/功能对比

```
A clean comparison chart for [对比主题].

Design: horizontal bar chart with [数量] bars.
Style: minimalist, professional data visualization.
Color: gradient from blue (#3b82f6) to purple (#7c3aed).

Data:
- [项目1]: [数值1]
- [项目2]: [数值2]
- [项目3]: [数值3]

Labels in simplified Chinese.
2.35:1 aspect ratio, white background.
```

### 2. 流程图

**适用**：步骤说明、操作流程

```
A simple flowchart for [流程主题].

Design: [数量] steps connected by arrows.
Style: clean, modern, easy to follow.
Color: blue (#3b82f6) accent on white background.

Steps:
1. [步骤1]
2. [步骤2]
3. [步骤3]

All text in simplified Chinese.
2.35:1 aspect ratio.
```

### 3. 架构图

**适用**：系统结构、技术方案

```
A technical architecture diagram for [架构主题].

Design: layered structure with [层数] layers.
Style: flat design, professional.
Color: each layer has distinct color.

Layers (top to bottom):
- [层1名称]: [说明]
- [层2名称]: [说明]
- [层3名称]: [说明]

Arrows showing data flow.
All text in simplified Chinese.
2.35:1 aspect ratio.
```

---

## 生成命令

```bash
cd /root/.claude/skills/wechat-product-manager-writer

python scripts/generate_image.py \
  --prompt "你的提示词" \
  --api gemini \
  --output comparison.png
```

---

## 嵌入文章

```markdown
## 性能对比

在响应速度方面，Claude 表现更好...

![性能对比](comparison.png)

除了速度，在准确率上...
```

**注意**：

- 配图紧跟相关段落
- 不要单独列「图片说明」章节
- 图片文件名用英文

---

## 质量检查

- [ ] 数据准确（来源可靠）
- [ ] 中文清晰可读
- [ ] 配图和文章内容匹配
- [ ] 总图片数不超过 3 张（含封面）
