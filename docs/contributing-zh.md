# 贡献指南

感谢你对 OpenClaw 的兴趣！本文档帮助你开始贡献。

## 快速开始

### 1. Fork & Clone
```bash
# Fork 后
git clone https://github.com/YOUR_USERNAME/openclaw.git
cd openclaw
```

### 2. 安装依赖
```bash
npm install
```

### 3. 运行测试
```bash
npm test
```

### 4. 创建分支
```bash
git checkout -b fix/your-fix-name
# 或
git checkout -b feat/your-feature-name
```

## PR 类型

### 🐛 Bug Fix
- 分支命名: `fix/description`
- 关联Issue
- 添加测试

### ✨ New Feature
- 分支命名: `feat/description`
- 先开Issue讨论
- 添加文档

### 📝 Documentation
- 分支命名: `docs/description`
- 修复typo或添加新文档

## 代码规范

- TypeScript
- ESLint 规则
- 单元测试覆盖
- 保持向后兼容

## 提交信息格式

```
type: 简短描述

详细描述（可选）

Fixes #issue-number
```

类型:
- `fix`: Bug修复
- `feat`: 新功能
- `docs`: 文档
- `refactor`: 重构
- `test`: 测试
- `chore`: 杂项

## 需要 Help?

- [Discord](https://discord.gg/clawd)
- [GitHub Discussions](https://github.com/openclaw/openclaw/discussions)
- [Issues](https://github.com/openclaw/openclaw/issues)

## License

MIT License - 贡献的代码将以相同许可发布。

---

🦞 Happy Contributing!
