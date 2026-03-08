---
name: wechat-article-formatter
description: 将Markdown文章转换为美化的HTML格式，适配微信公众号发布。应用专业CSS样式、代码高亮、优化排版。当用户说"美化这篇文章"、"转换为HTML"、"优化公众号格式"、"生成公众号HTML"时使用。
allowed-tools: Read, Write, Bash
---

# 微信公众号文章格式化工具（Claude 执行指南）

**目标**：将 Markdown 文章转换为适配微信公众号的精美 HTML，实现一键发布。

**核心价值**：效率提升 15 倍（30分钟 → 2分钟），格式一致专业。

---

## ⚡ 执行流程（严格遵守）

### 步骤1：获取输入文件

**场景判断**：

| 场景                        | 如何处理                                  |
| --------------------------- | ----------------------------------------- |
| 用户提供文件路径            | 直接使用该路径                            |
| 用户粘贴 Markdown 内容      | 先使用 Write 工具保存为 .md 文件          |
| 刚使用过 wechat-tech-writer | 自动查找最新生成的 .md 文件（见集成指导） |
| 用户只说"美化文章"          | 询问用户：文件路径或粘贴内容              |

**自动检测最新文章**（与 wechat-tech-writer 集成）：

```bash
# 查找当前目录最新的 .md 文件
latest_md=$(ls -t *.md 2>/dev/null | head -1)
if [ -n "$latest_md" ]; then
    echo "检测到最新文章：$latest_md"
fi
```

---

### 步骤2：检查 examples 目录（优先使用精美模板）

**⚠️ 重要规则**：

1. **优先使用 examples 中的精美模板**，而非基础 CSS 主题
2. **不要渲染 H1 标题**：微信公众号有独立的标题输入框，HTML 中不应包含文章标题

**检查命令**：

```bash
cd /root/.claude/skills/wechat-article-formatter
ls -lh examples/
```

**可用模板**：

| 模板文件                       | 风格特色                                 | 适用场景                 |
| ------------------------------ | ---------------------------------------- | ------------------------ |
| **VSCode 蓝色科技风.html**     | 导语块、序号章节标题、功能卡片、操作步骤 | 技术文章、产品介绍、教程 |
| **红蓝对决·深度测评模板.html** | 渐变标题、对比卡片、数据表格、引用金句   | 对比评测、深度分析       |
| **极客暗黑风.html**            | 深色背景、极客风格                       | 技术深度文章、黑客风格   |
| **现代极简风.html**            | 简约清爽                                 | 通用文章、简洁风格       |

**选择逻辑**：

```
文章分析：
├─ 技术/产品介绍类 → VSCode 蓝色科技风 ✅
├─ 对比/评测类 → 红蓝对决模板 ✅
├─ 深度技术文章 → 极客暗黑风
└─ 通用内容 → 现代极简风
```

**执行方式**：

1. 读取选中的模板文件
2. 参照模板的组件结构（导语块、卡片、步骤列表等）
3. **跳过 Markdown 中的 H1 标题**（# 标题），从第一个段落或 H2（## 章节）开始
4. 手动将 Markdown 内容映射到模板组件中
5. 在 HTML 开头添加注释：`<!-- ⚠️ 标题请在微信公众号编辑器中单独填写 -->`
6. **⚠️ 关键步骤：转换代码块格式**
   - 使用 `scripts/convert-code-blocks.py` 将生成的 HTML 中的代码块转换为微信兼容格式
   - 命令：`python scripts/convert-code-blocks.py input.html output.html`
   - 这会将 `<pre><code>` 转换为 `<div>` + `<br>` + `&nbsp;` 格式（微信唯一支持的代码块格式）
7. 生成精美的 HTML 文件

**如果没有合适的模板**，才使用步骤3的基础 CSS 主题转换。

---

### 步骤3：选择基础主题（仅当 examples 无合适模板时使用）

**决策树**（自动选择 OR 询问用户）：

````
文章内容分析：
├─ 包含代码块（```）或技术词汇多 → tech（科技风）
├─ 包含数据表格、商业术语 → business（商务风）
└─ 纯文字、通用内容 → minimal（简约风）
````

**主题对照表**：

| 主题         | 适用场景               | 配色     | 何时使用                                 |
| ------------ | ---------------------- | -------- | ---------------------------------------- |
| **tech**     | 技术文章、AI、编程教程 | 蓝紫渐变 | 默认选择，来自 wechat-tech-writer 的文章 |
| **minimal**  | 生活随笔、读书笔记     | 黑白灰   | 纯文字内容，无代码                       |
| **business** | 商业报告、数据分析     | 深蓝金   | 包含表格、数据、图表                     |

**如何询问用户**：

```
检测到文章包含代码块，建议使用 tech 主题。
需要切换主题吗？（tech / minimal / business）
```

---

### 步骤4：执行转换

**标准转换命令**：

```bash
cd /root/.claude/skills/wechat-article-formatter

python scripts/markdown_to_html.py \
  --input "{文件路径}" \
  --theme {主题名} \
  --output "{输出路径}" \
  --preview
```

**参数说明**：

- `--input`：Markdown 文件路径（必需）
- `--theme`：tech / minimal / business（默认 tech）
- `--output`：HTML 输出路径（可选，默认同名 .html）
- `--preview`：转换后自动在浏览器打开预览（推荐）

**示例**：

```bash
# 最常用：使用 tech 主题转换并预览
python scripts/markdown_to_html.py \
  --input "Claude_Sonnet_4介绍.md" \
  --theme tech \
  --preview
```

---

### 步骤5：质量检查

**转换完成后，必须检查**：

使用 Read 工具读取生成的 HTML 文件（前 50 行），检查：

| 检查项   | 如何验证                              | 常见问题                            |
| -------- | ------------------------------------- | ----------------------------------- |
| 标题样式 | 查看 `<h1>`, `<h2>` 标签的 style 属性 | 样式丢失 → 重新转换                 |
| 代码高亮 | 查看 `<pre><code>` 是否有语言标识     | 无高亮 → 检查 Markdown 是否指定语言 |
| 图片路径 | 查看 `<img src="">` 的路径            | 本地路径 → 提醒用户需上传到微信     |
| 表格格式 | 查看 `<table>` 是否有内联样式         | 格式混乱 → 简化表格列数             |

**快速检查命令**：

```bash
# 查看 HTML 文件前 50 行
head -50 output.html
```

---

### 步骤6：预览和反馈

**询问用户**：

```
✅ 转换成功！已生成：{输出文件路径}

预览效果：
- 已在浏览器打开预览
- 或访问：file://{绝对路径}

请检查效果，满意吗？
- 满意 → 进入步骤6（发布指导）
- 需要调整 → 可以切换主题或手动修复
```

**如果用户不满意**：

| 问题             | 解决方案                                         |
| ---------------- | ------------------------------------------------ |
| "颜色不喜欢"     | 切换主题重新生成（tech/minimal/business）        |
| "代码块没高亮"   | 检查 Markdown 代码块是否指定语言（\`\`\`python） |
| "图片显示不正常" | 提醒：本地图片需上传到微信编辑器                 |
| "表格太宽"       | 建议简化表格（≤4列）或接受横向滚动               |

---

### 步骤7：发布指导

**输出给用户的完整指导**：

```
📋 发布到微信公众号步骤：

1. 打开微信公众号编辑器
2. ✅ 在标题栏填写文章标题：{从 Markdown 提取的标题}
3. 打开生成的 HTML 文件：{文件路径}
4. 在浏览器中按 Ctrl+A（全选）→ Ctrl+C（复制）
5. 粘贴到编辑器正文区（Ctrl+V）
6. 处理图片：
   - 删除无法显示的本地图片引用
   - 重新上传图片到微信编辑器
6. 最后检查：标题层级、段落间距、代码块
7. 使用微信编辑器的"预览"功能在手机查看
8. 确认无误后发布

⚠️ 注意事项：
- 样式已内联，可直接粘贴
- 本地图片需重新上传
- 粘贴后微信编辑器可能微调部分样式（正常）

详细发布指南：references/publishing-guide.md
```

---

## 🔄 与 wechat-tech-writer 集成

### 场景：刚用 wechat-tech-writer 生成文章

**识别标志**：

- 用户刚说过"写一篇关于XXX的文章"
- 当前目录有新生成的 .md 文件

**自动化流程**：

```bash
# 1. 查找最新文章
latest_article=$(ls -t *.md 2>/dev/null | head -1)

# 2. 确认是否是目标文章
echo "检测到最新文章：$latest_article"
echo "是否要转换这篇文章？(y/n)"

# 3. 自动选择 tech 主题（wechat-tech-writer 主要生成技术文章）
python scripts/markdown_to_html.py \
  --input "$latest_article" \
  --theme tech \
  --preview
```

**无缝衔接话术**：

```
检测到你刚用 wechat-tech-writer 生成了文章：{文件名}
现在为你美化格式，使用 tech 主题...
```

---

## ❌ 错误处理表

| 错误信息                                  | 原因                | Claude 应该做什么                   |
| ----------------------------------------- | ------------------- | ----------------------------------- |
| `FileNotFoundError: Input file not found` | 文件路径错误        | 询问用户正确的文件路径              |
| `Unknown theme: xxx`                      | 主题名错误          | 提示可用主题：tech/minimal/business |
| `Theme CSS file not found`                | 主题文件缺失        | 使用默认 tech 主题重试              |
| 转换成功但代码无高亮                      | Markdown 未指定语言 | 提醒用户修改代码块（\`\`\`python）  |
| 图片无法显示                              | 本地路径或外链失效  | 提醒用户在微信编辑器重新上传        |
| 表格格式混乱                              | 表格过宽            | 建议简化表格或转为图片              |

---

## 📚 快速参考

### 最常用的 3 个命令

**1. 标准转换**（最常用）：

```bash
python scripts/markdown_to_html.py --input article.md --theme tech --preview
```

**2. 批量转换**（多篇文章）：

```bash
python scripts/batch_convert.py --input articles/ --theme minimal --workers 8
```

**3. 实时预览**（边写边看）：

```bash
python scripts/preview_generator.py --input article.md --theme business
```

### 常见问题快速解答

**Q: 粘贴到微信后样式丢失？**
A: 使用"粘贴"而非"粘贴并匹配样式"，或清空编辑器后重新粘贴。

**Q: 代码块没有高亮？**
A: 确保 Markdown 中指定了语言：\`\`\`python（不是 \`\`\`）

**Q: 如何自定义主题颜色？**
A: 复制 `templates/tech-theme.css` → 修改颜色变量 → 使用 `--theme my-theme`

---

## 📖 完整文档导航

**本文档（SKILL.md）**：Claude 执行指南（精简版）

**其他文档**（用户手册）：

- **QUICKSTART.md** - 3 分钟快速开始（新增）
- **README.md** - 完整功能介绍和参数说明
- **EXAMPLES.md** - 3 个详细使用示例
- **references/publishing-guide.md** - 详细发布步骤
- **references/theme-customization.md** - 主题自定义指南
- **references/wechat-constraints.md** - 微信平台限制说明

**如何使用文档**：

- Claude 主要看 **SKILL.md**（本文档）和 **QUICKSTART.md**
- 需要详细信息时再看 references/ 目录
- 用户主要看 **README.md** 和 **EXAMPLES.md**

---

## ✅ 执行检查清单（每次执行完毕后确认）

- [ ] 已获取输入文件（路径或内容）
- [ ] 已选择合适主题（自动判断或询问用户）
- [ ] 已执行转换命令
- [ ] 已检查生成的 HTML 文件（标题、代码、图片）
- [ ] 已询问用户预览效果是否满意
- [ ] 已提供完整的发布指导
- [ ] 已处理可能出现的错误

---

**记住**：这个 skill 的核心是**自动化 + 专业化**，让用户 2 分钟完成原本 30 分钟的工作！
