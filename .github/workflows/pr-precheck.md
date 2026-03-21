# PR 提交前检查清单

## 📋 文档翻译 PR 必查项目

### 1. 路径检查
- [ ] 所有相对链接路径正确（从 `docs/zh-CN/` 目录解析）
- [ ] 图片路径使用 `../assets/` 而不是 `docs/assets/`
- [ ] 根目录文件链接使用 `../../filename.md`
- [ ] 无本地文件系统路径暴露（如 `/home/admin/...`）

### 2. 文件检查
- [ ] 不包含 PR 描述模板等提交产物
- [ ] 只提交实际文档文件
- [ ] 翻译报告使用仓库相对路径

### 3. 内容检查
- [ ] 术语列表精简且相关（无网络俚语、加密货币术语等）
- [ ] 术语翻译一致
- [ ] 品牌名称保持原文

### 4. 格式检查
- [ ] Markdown 格式正确
- [ ] 无格式错误

---

## 🛠️ 运行检查命令

### 提交前必须运行的命令

```bash
# 1. 文档检查
pnpm docs:check

# 2. 文档 lint
pnpm lint:docs

# 3. i18n 术语表检查
pnpm docs:check-i18n-glossary

# 4. 链接检查
pnpm docs:check-links

# 5. 综合检查（推荐）
pnpm check
```

### 完整检查流程

```bash
# 切换到文档目录
cd /home/admin/openclaw/workspace/openclaw-official

# 运行所有检查
pnpm install  # 确保依赖安装
pnpm docs:check && pnpm lint:docs && pnpm docs:check-i18n-glossary && pnpm docs:check-links

# 如果全部通过，再提交
git add .
git commit -m "docs: your message"
git push
```

---

## ⚠️ 常见错误

### 路径错误
❌ 错误：`[愿景](VISION.md)`  
✅ 正确：`[愿景](../../VISION.md)`

❌ 错误：`![Logo](docs/assets/logo.png)`  
✅ 正确：`![Logo](../assets/logo.png)`

### 本地路径暴露
❌ 错误：`/home/admin/openclaw/workspace/openclaw-official/README.md`  
✅ 正确：`README.md`

### 提交无关文件
❌ 错误：提交 `PR_DESCRIPTION.md`、`TRANSLATION_NOTES.md` 等模板文件  
✅ 正确：只提交实际文档

### 术语列表冗长
❌ 错误：包含数百个无关术语（YOLO、GOAT、DeFi 等）  
✅ 正确：只保留与项目相关的核心技术术语

---

## 📝 检查清单模板

复制以下清单到提交前检查：

```markdown
## PR 提交前检查

- [ ] 运行 `pnpm docs:check` 通过
- [ ] 运行 `pnpm lint:docs` 通过
- [ ] 运行 `pnpm docs:check-i18n-glossary` 通过
- [ ] 运行 `pnpm docs:check-links` 通过
- [ ] 检查所有相对路径正确
- [ ] 无本地路径暴露
- [ ] 无无关文件提交
- [ ] 术语列表精简相关
```

---

**最后更新**: 2026-03-22  
**基于**: PR #51839 审核反馈
