# References Documentation

本目录包含 `wechat-article-formatter` skill 的详细参考文档。

---

## 📚 文档清单

### 1. [微信公众号平台限制说明](wechat-constraints.md)

**wechat-constraints.md** - 必读文档

详细说明微信公众号编辑器的技术限制，以及本工具如何应对这些限制。

**包含内容**:

- CSS/JavaScript限制
- 图片处理限制
- 代码块限制
- 排版限制
- 兼容性建议
- 发布前检查清单
- 故障排除

**适合人群**: 所有用户，尤其是首次使用者

---

### 2. [Markdown到HTML转换详细指南](conversion-guide.md)

**conversion-guide.md** - 技术文档

深入讲解Markdown转HTML的转换过程、技术实现和高级用法。

**包含内容**:

- 转换流程详解
- Markdown扩展说明
- CSS处理机制
- 特殊元素处理
- 高级用法示例
- 性能优化技巧
- 调试技巧

**适合人群**: 需要深入理解转换机制的用户、开发者

---

### 3. [微信公众号发布完整指南](publishing-guide.md)

**publishing-guide.md** - 实用指南

从HTML转换到微信公众号发布的完整工作流程。

**包含内容**:

- 发布流程概览（9个详细步骤）
- 不同内容类型的发布建议
- 优化技巧（提高打开率、阅读体验、互动率）
- 常见问题处理
- 发布检查清单
- 进阶技巧（定时发布、原创声明、数据分析）

**适合人群**: 所有用户，尤其是内容创作者和新媒体运营者

---

### 4. [主题自定义完整指南](theme-customization.md)

**theme-customization.md** - 定制指南

详细说明如何自定义CSS主题，创建专属的微信公众号文章样式。

**包含内容**:

- 主题文件结构
- CSS变量系统详解
- 创建自定义主题（两种方法）
- 主题配色方案（7种配色示例）
- 样式定制详解（标题、代码块、表格、引用块）
- 响应式设计
- 高级技巧

**适合人群**: 需要定制样式的用户、设计师、前端开发者

---

## 🚀 快速开始

### 新手用户

建议按以下顺序阅读：

1. **[publishing-guide.md](publishing-guide.md)** - 了解完整发布流程
2. **[wechat-constraints.md](wechat-constraints.md)** - 了解平台限制
3. 回到主文档 **[SKILL.md](../SKILL.md)** 开始使用

### 进阶用户

如果你想：

- **自定义主题样式** → 阅读 [theme-customization.md](theme-customization.md)
- **深入了解转换机制** → 阅读 [conversion-guide.md](conversion-guide.md)
- **解决发布问题** → 查阅 [publishing-guide.md](publishing-guide.md) 的故障排除章节
- **理解平台限制** → 参考 [wechat-constraints.md](wechat-constraints.md)

---

## 📖 文档特点

### wechat-constraints.md

- ✅ 9大核心技术限制详解
- ✅ 本工具的解决方案说明
- ✅ 兼容性最佳实践
- ✅ 发布前完整检查清单
- ✅ 常见问题故障排除

### conversion-guide.md

- ✅ 5步转换流程图解
- ✅ 4种Markdown扩展说明
- ✅ CSS处理详细技术细节
- ✅ 性能优化建议
- ✅ 调试技巧和工具

### publishing-guide.md

- ✅ 9步详细发布流程
- ✅ 3种内容类型发布建议（技术/商业/通用）
- ✅ 提高打开率/阅读体验/互动率的优化技巧
- ✅ 5个常见问题的解决方案
- ✅ 完整的发布前后检查清单

### theme-customization.md

- ✅ 完整的主题文件结构说明
- ✅ CSS变量系统深入讲解
- ✅ 7种配色方案示例
- ✅ 标题/代码/表格/引用块样式定制
- ✅ 响应式设计最佳实践

---

## 🔍 常见问题快速索引

### 技术问题

| 问题             | 参考文档               | 章节             |
| ---------------- | ---------------------- | ---------------- |
| 样式在微信中丢失 | wechat-constraints.md  | 6. 故障排除 → Q1 |
| 代码块格式混乱   | wechat-constraints.md  | 6. 故障排除 → Q2 |
| 表格显示异常     | wechat-constraints.md  | 6. 故障排除 → Q3 |
| 图片无法显示     | wechat-constraints.md  | 6. 故障排除 → Q4 |
| CSS变量不生效    | theme-customization.md | 9. 故障排除 → Q1 |

### 使用问题

| 问题         | 参考文档            | 章节                      |
| ------------ | ------------------- | ------------------------- |
| 如何选择主题 | publishing-guide.md | 3. 不同内容类型的发布建议 |
| 如何上传图片 | publishing-guide.md | 2. 详细发布步骤 → 步骤5   |
| 如何优化封面 | publishing-guide.md | 4.1 提高打开率            |
| 如何调整格式 | publishing-guide.md | 2. 详细发布步骤 → 步骤6   |
| 如何手机预览 | publishing-guide.md | 2. 详细发布步骤 → 步骤7   |

### 定制问题

| 问题               | 参考文档               | 章节               |
| ------------------ | ---------------------- | ------------------ |
| 如何创建自定义主题 | theme-customization.md | 3. 创建自定义主题  |
| 如何修改颜色       | theme-customization.md | 2. CSS变量系统     |
| 如何定制标题样式   | theme-customization.md | 5.1 标题样式定制   |
| 如何定制代码块     | theme-customization.md | 5.2 代码块样式定制 |
| 如何定制表格       | theme-customization.md | 5.3 表格样式定制   |

---

## 💡 最佳实践

### 发布前必看

1. ✅ 阅读 [wechat-constraints.md](wechat-constraints.md) 了解平台限制
2. ✅ 使用 [publishing-guide.md](publishing-guide.md) 的检查清单
3. ✅ 在本地浏览器预览
4. ✅ 在手机端测试

### 主题定制必看

1. ✅ 先选择一个接近的现有主题
2. ✅ 阅读 [theme-customization.md](theme-customization.md) 第3节
3. ✅ 使用CSS变量修改颜色
4. ✅ 测试所有元素样式

### 故障排除必看

1. ✅ 检查 [wechat-constraints.md](wechat-constraints.md) 的故障排除章节
2. ✅ 查阅 [publishing-guide.md](publishing-guide.md) 的常见问题
3. ✅ 使用浏览器开发者工具调试
4. ✅ 对比示例文章效果

---

## 📝 文档更新日志

### 2025-12-28

- ✅ 创建完整的references文档体系
- ✅ 新增 wechat-constraints.md
- ✅ 新增 conversion-guide.md
- ✅ 新增 publishing-guide.md
- ✅ 新增 theme-customization.md
- ✅ 新增 README.md（本文档）

---

## 🔗 相关资源

### 内部文档

- [SKILL.md](../SKILL.md) - 主技能文档
- [EXAMPLES.md](../EXAMPLES.md) - 使用示例（3个完整案例）
- [templates/](../templates/) - CSS主题模板
- [scripts/](../scripts/) - 转换脚本

### 外部资源

- [微信公众平台官方帮助](https://kf.qq.com/product/weixinmp.html)
- [Python-Markdown文档](https://python-markdown.github.io/)
- [CSS变量教程(MDN)](https://developer.mozilla.org/zh-CN/docs/Web/CSS/Using_CSS_custom_properties)

---

## 🙋 反馈建议

如果你发现文档有误或有改进建议，欢迎：

1. 直接修改文档文件
2. 补充缺失的内容
3. 改进示例和说明

**祝你使用愉快！** 🎉
