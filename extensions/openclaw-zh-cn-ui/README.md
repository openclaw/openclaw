# OpenClaw 中文界面翻译

在你的项目中导入：

```javascript
const translations = require("./translations/zh-CN.json");
console.log(transl["Save"]); // 输出：保存
```

## 继续翻译工作

1. **提取 OpenClaw 界面字符串**

   ```bash
   node scripts/extract-strings.js
   ```

2. **过滤真正的界面文本**

   ```bash
   node scripts/filter-real-ui.js
   ```

3. **翻译剩余的字符串**
   - 编辑 `translations/ui-only.json`

## 🛠️ 工具说明

- `scripts/extract-strings.js`  
  从 OpenClaw 源代码中提取所有可翻译的字符串。

- `scripts/filter-real-ui.js`  
  智能过滤出真正的界面文本，排除代码片段和变量名。

- `scripts/smart-translate.js`  
  应用技术术语词典和简单翻译规则进行批量翻译。

## 📁 项目结构

```
extensions/openclaw-zh-cn-ui/
├── README.md
├── translations/
│   └── zh-CN.json
├── scripts/
│   ├── extract-strings.js
│   ├── filter-real-ui.js
│   └── smart-translate.js
└── docs/
    ├── CONTRIBUTING.md
    ├── IMPLEMENTATION.md
    └── ROADMAP.md
```

## 🤝 如何贡献

- 报告翻译问题
- 提交翻译改进
- 优化工具脚本
- 完善使用文档

## 🔧 集成方案

需要前端国际化、CLI 本地化和构建系统集成。

## 📈 路线图

### 短期目标

- 完成剩余翻译
- 提交 Pull Request

### 长期目标

- 支持更多语言
- 创建翻译平台

## 📄 许可证

MIT License

## 🙏 致谢

感谢所有贡献者！

---

更新于 2026-02-16 | OpenClaw 中文社区
