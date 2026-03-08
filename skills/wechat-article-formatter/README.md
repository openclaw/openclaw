# WeChat Article Formatter

将Markdown文章转换为适合微信公众号的美化HTML，一键生成专业排版。

---

## ✨ 核心功能

- 📝 **Markdown转HTML** - 完整支持Markdown语法
- 🎨 **多套主题** - tech（科技风）、minimal（简约风）、business（商务风）
- 💅 **样式美化** - 专业的CSS样式，适配微信公众号
- 🌈 **代码高亮** - 支持多种编程语言的语法高亮
- 📱 **响应式设计** - 完美适配移动端阅读
- ⚡ **批量转换** - 支持批量处理多个文件
- 👀 **实时预览** - 边写边看，提高效率
- 🔧 **高度可定制** - 支持自定义CSS主题

---

## 🚀 快速开始

### 1. 转换单篇文章

```bash
python scripts/markdown_to_html.py \
  --input article.md \
  --theme tech \
  --preview
```

### 2. 批量转换

```bash
python scripts/batch_convert.py \
  --input articles/ \
  --theme minimal \
  --workers 8
```

### 3. 实时预览

```bash
python scripts/preview_generator.py \
  --input article.md \
  --theme business
```

---

## 📚 文档导航

### 入门文档

- **[SKILL.md](SKILL.md)** - 完整使用指南和快速参考
- **[EXAMPLES.md](EXAMPLES.md)** - 3个详细使用示例

### 参考文档

- **[references/](references/)** - 详细技术文档
  - [wechat-constraints.md](references/wechat-constraints.md) - 微信平台限制说明
  - [conversion-guide.md](references/conversion-guide.md) - 转换过程详解
  - [publishing-guide.md](references/publishing-guide.md) - 发布完整指南
  - [theme-customization.md](references/theme-customization.md) - 主题自定义指南

---

## 🎨 主题预览

### Tech主题（科技风）

- **配色**: 蓝紫渐变
- **适用**: 技术文章、开发教程、AI/科技内容
- **特点**: 现代科技感，Atom One Dark代码高亮

### Minimal主题（简约风）

- **配色**: 黑白灰
- **适用**: 通用文章、文学作品、简洁风格
- **特点**: 极简设计，GitHub风格代码块

### Business主题（商务风）

- **配色**: 深蓝金色
- **适用**: 商业分析、企业内容、专业报告
- **特点**: 专业稳重，Monokai代码高亮

---

## 📦 文件结构

```
wechat-article-formatter/
├── SKILL.md                    # 主技能文档
├── README.md                   # 本文件
├── EXAMPLES.md                 # 使用示例
├── requirements.txt            # Python依赖
├── test_article.md             # 测试文件
│
├── scripts/                    # 转换脚本
│   ├── markdown_to_html.py     # 主转换脚本
│   ├── batch_convert.py        # 批量转换
│   └── preview_generator.py    # 实时预览
│
├── templates/                  # CSS主题模板
│   ├── tech-theme.css          # 科技风主题
│   ├── minimal-theme.css       # 简约风主题
│   └── business-theme.css      # 商务风主题
│
└── references/                 # 参考文档
    ├── README.md               # 文档导航
    ├── wechat-constraints.md   # 平台限制
    ├── conversion-guide.md     # 转换详解
    ├── publishing-guide.md     # 发布指南
    └── theme-customization.md  # 主题定制
```

---

## 🛠️ 安装依赖

```bash
# 安装Python依赖
pip install -r requirements.txt
```

### 依赖包说明

- `markdown` - Markdown解析
- `beautifulsoup4` - HTML处理
- `cssutils` - CSS解析
- `lxml` - XML/HTML解析
- `watchdog` - 文件监听（实时预览用）
- `Pygments` - 语法高亮（可选）

---

## 📖 使用示例

### 示例1: 转换技术文章

```bash
# 使用tech主题转换
python scripts/markdown_to_html.py \
  --input /path/to/tech-article.md \
  --theme tech \
  --output /path/to/output.html \
  --preview
```

**输出**: 带有蓝紫渐变配色、Atom One Dark代码高亮的HTML文件

### 示例2: 批量转换博客文章

```bash
# 批量转换目录下所有Markdown文件
python scripts/batch_convert.py \
  --input /path/to/blog/ \
  --output /path/to/output/ \
  --theme minimal \
  --workers 8
```

**输出**: 所有文章转换为简约风格的HTML文件

### 示例3: 边写边预览

```bash
# 启动实时预览服务
python scripts/preview_generator.py \
  --input /path/to/article.md \
  --theme business \
  --port 8080
```

**效果**: 在浏览器中实时预览，保存Markdown文件后刷新即可看到最新效果

---

## ⚙️ 命令行参数

### markdown_to_html.py

```
用法: python markdown_to_html.py [选项]

选项:
  -i, --input INPUT     输入的Markdown文件路径（必需）
  -o, --output OUTPUT   输出的HTML文件路径（可选，默认与输入同名）
  -t, --theme THEME     主题选择: tech, minimal, business（默认：tech）
  -p, --preview         转换后在浏览器中打开预览
  -h, --help            显示帮助信息
```

### batch_convert.py

```
用法: python batch_convert.py [选项]

选项:
  -i, --input INPUT     输入的Markdown文件或目录路径（必需）
  -o, --output OUTPUT   输出目录（可选，默认与源文件同目录）
  -t, --theme THEME     主题选择: tech, minimal, business（默认：tech）
  -r, --recursive       递归查找子目录中的Markdown文件
  -w, --workers NUM     并发转换的线程数（默认：4）
  -q, --quiet           静默模式，只显示摘要
  -h, --help            显示帮助信息
```

### preview_generator.py

```
用法: python preview_generator.py [选项]

选项:
  -i, --input INPUT     输入的Markdown文件路径（必需）
  -o, --output OUTPUT   输出目录（默认：./preview/）
  -t, --theme THEME     主题选择: tech, minimal, business（默认：tech）
  -p, --port PORT       HTTP服务器端口（默认：8000）
  --no-browser          不自动打开浏览器
  -h, --help            显示帮助信息
```

---

## 🎯 使用场景

### 技术博客

- **推荐主题**: tech
- **特点**: 代码高亮专业、科技感强
- **适合**: 编程教程、技术解析、AI内容

### 生活随笔

- **推荐主题**: minimal
- **特点**: 简洁清爽、易读性强
- **适合**: 生活记录、读书笔记、通用文章

### 商业报告

- **推荐主题**: business
- **特点**: 专业稳重、数据展示清晰
- **适合**: 业绩分析、市场报告、商业计划

---

## ✅ 发布流程

1. **转换Markdown为HTML**

   ```bash
   python scripts/markdown_to_html.py --input article.md --theme tech --preview
   ```

2. **本地预览检查**
   - 在浏览器中查看效果
   - 检查标题、代码块、表格等元素

3. **复制到微信编辑器**
   - 在浏览器中按 `Ctrl+A` 全选
   - 按 `Ctrl+C` 复制
   - 粘贴到微信公众号编辑器

4. **处理图片**
   - 删除无法显示的本地图片
   - 重新上传图片到微信编辑器

5. **调整格式**
   - 检查标题层级
   - 调整段落间距
   - 验证代码块和表格

6. **手机端预览**
   - 使用微信编辑器的预览功能
   - 在手机上查看实际效果

7. **发布**
   - 确认无误后发布文章

详细发布流程请参考 [publishing-guide.md](references/publishing-guide.md)

---

## 🔧 主题自定义

### 快速修改颜色

1. 复制现有主题文件

   ```bash
   cp templates/tech-theme.css templates/my-theme.css
   ```

2. 修改CSS变量

   ```css
   :root {
     --primary-color: #10b981; /* 改为绿色 */
     --secondary-color: #14b8a6;
   }
   ```

3. 使用自定义主题
   ```bash
   python scripts/markdown_to_html.py --input article.md --theme my
   ```

详细自定义指南请参考 [theme-customization.md](references/theme-customization.md)

---

## ⚠️ 注意事项

### 微信公众号限制

1. **不支持外部CSS** - 本工具会自动转换为内联样式
2. **不支持JavaScript** - 使用纯CSS实现所有效果
3. **图片需要重新上传** - 本地图片无法直接使用
4. **部分CSS属性不支持** - 只使用微信支持的CSS属性

详细限制说明请参考 [wechat-constraints.md](references/wechat-constraints.md)

### 最佳实践

1. **文章长度**: 建议 2000-5000 字
2. **图片数量**: 建议 4-8 张
3. **表格列数**: 建议 ≤ 4 列（移动端友好）
4. **代码块长度**: 建议 < 30 行

---

## 🐛 故障排除

### 粘贴后样式丢失

- 使用Chrome或Edge浏览器
- 尝试复制HTML源代码而非页面内容

### 代码块格式混乱

- 确认代码块有语言标识（\`\`\`python）
- 或使用微信编辑器的"代码块"功能重新插入

### 表格在手机上显示不全

- 减少表格列数（≤ 4列）
- 或将表格转为图片

### 图片无法显示

- 在微信编辑器中重新上传图片
- 或使用图床服务（阿里云OSS、七牛云等）

更多问题请参考 [wechat-constraints.md](references/wechat-constraints.md) 的故障排除章节

---

## 📊 性能指标

- **单文件转换**: ~0.3-0.5秒
- **批量转换（8线程）**: ~0.37秒/篇
- **实时预览更新**: <1秒
- **HTML文件大小**: ~50KB（包含内联CSS）

---

## 🔗 相关资源

### 官方文档

- [微信公众平台帮助中心](https://kf.qq.com/product/weixinmp.html)
- [Python-Markdown文档](https://python-markdown.github.io/)
- [BeautifulSoup文档](https://www.crummy.com/software/BeautifulSoup/)

### 推荐工具

- **图床服务**: 阿里云OSS、七牛云、GitHub图床
- **Markdown编辑器**: Typora、VS Code、Obsidian
- **配色工具**: Coolors.co、Adobe Color

### 社区

- 微信公众号运营交流群
- 新媒体运营论坛

---

## 📝 更新日志

### v1.0.0 (2025-12-28)

- ✅ 初始版本发布
- ✅ 3套CSS主题（tech, minimal, business）
- ✅ 3个转换脚本（单文件、批量、实时预览）
- ✅ 完整的文档体系
- ✅ 测试文件和示例

---

## 🙏 致谢

本skill基于以下开源项目：

- [Python-Markdown](https://python-markdown.github.io/)
- [BeautifulSoup4](https://www.crummy.com/software/BeautifulSoup/)
- [cssutils](https://cssutils.readthedocs.io/)

---

## 📄 许可证

本项目为Claude Code Skill，供个人和商业使用。

---

**祝你使用愉快！** 🎉

如有问题或建议，欢迎反馈！
