# PR 提交检查清单

确保你的 PR 符合 OpenClaw 项目的合并标准。

---

## 📋 提交前检查（必须 100% 完成）

### 1. 代码质量

- [ ] **运行测试**: `pnpm test <affected-files>`
- [ ] **代码检查**: `pnpm check` (必须 0 errors, 0 warnings)
- [ ] **构建验证**: `pnpm build` (必须成功)
- [ ] **无冲突**: `git merge upstream/main --no-commit` (必须无冲突)

### 2. 测试覆盖

- [ ] 添加了必要的测试用例
- [ ] 覆盖边界情况（null, empty, edge cases）
- [ ] 回归测试（如果适用）
- [ ] 所有测试通过

### 3. 文档更新

- [ ] 更新了 `CHANGELOG.md`
- [ ] 更新了相关文档（如果适用）
- [ ] Commit message 符合 Conventional Commits
- [ ] PR 描述完整（使用模板）

### 4. upstream 检查

- [ ] 检查 issue 是否已被其他人修复
- [ ] 检查是否有重复的 PR
- [ ] 确认分支基于最新 upstream/main

```bash
# 检查 upstream
git fetch upstream
git log upstream/main --oneline --grep="<issue-number>"
gh pr list --state merged --search "<keywords>"
```

### 5. 安全检查

- [ ] 无硬编码的 secrets/tokens
- [ ] 用户输入已验证
- [ ] 网络调用有超时和错误处理
- [ ] 文件操作有权限检查

---

## 🚀 提交流程

### 步骤 1: 创建分支

```bash
# 同步 upstream
git checkout main
git fetch upstream
git reset --hard upstream/main

# 创建特性分支
git checkout -b fix/<issue-number>-brief-description
```

### 步骤 2: 开发和测试

```bash
# 编写代码和测试
# ...

# 运行测试
pnpm test src/<path>/<to>/<file>.test.ts

# 代码检查
pnpm check

# 构建验证
pnpm build
```

### 步骤 3: 提交

```bash
# 添加文件
git add <files>

# 提交（使用 Conventional Commits）
git commit -m "fix(scope): brief description

Detailed explanation of what changed and why.

Fixes #<issue-number>"

# 推送到 fork
git push -u origin <branch-name>
```

### 步骤 4: 创建 PR

1. **访问**: https://github.com/openclaw/openclaw/compare
2. **选择**:
   - Base: `openclaw/openclaw:main`
   - Compare: `<your-username>:<branch-name>`
3. **填写 PR 模板** (已自动加载)
4. **提交 PR**

### 步骤 5: 监控审查

```bash
# 启动审查监控（可选）
./scripts/monitor-pr-reviews.sh <PR_NUMBER>

# 或手动检查
gh pr view <PR_NUMBER> --json reviews,comments
```

---

## ⚡ 快速响应审查

### 收到审查通知

1. **5 分钟内**: 确认收到（点赞或回复）
2. **15 分钟内**: 评估审查意见
3. **30 分钟内**: 开始修复

### 修复审查意见

```bash
# 1. 修复问题
# 编辑文件...

# 2. 提交修复
git add <files>
git commit -m "address review: <brief-description>"

# 3. 推送
git push

# 4. 回复审查
# 在评论中@审查者，说明已修复
```

### 批量响应示例

```markdown
## Review Response

Thanks @reviewer for the feedback!

### Addressed:

1. **Issue 1** - Fixed in commit abc123
2. **Issue 2** - Fixed in commit def456
3. **Issue 3** - Added test in commit ghi789

### Verification:

- [x] pnpm test (all passing)
- [x] pnpm check (0 errors)

Ready for re-review! 🚀
```

---

## 🎯 成功标准

### ✅ 可合并的 PR

- ✅ 所有测试通过
- ✅ 代码检查 0 errors
- ✅ 无合并冲突
- ✅ 所有审查意见已解决
- ✅ CHANGELOG 已更新
- ✅ 向后兼容（或明确标注 breaking changes）

### ❌ 会被拒绝的 PR

- ❌ 有合并冲突（mergeStateStatus: DIRTY）
- ❌ 测试失败
- ❌ 代码检查有 errors
- ❌ 未响应审查意见
- ❌ 重复修复（upstream 已修复）
- ❌ 缺少测试覆盖

---

## 📊 指标追踪

记录你的 PR 表现：

| PR #  | 提交日期   | 合并日期 | 审查数量 | 平均响应时间 | 结果    |
| ----- | ---------- | -------- | -------- | ------------ | ------- |
| 45813 | 2026-03-14 | -        | 0        | -            | ⏳ Open |

**目标**:

- 合并成功率 >80%
- 平均响应时间 <30 分钟
- 审查解决率 100%

---

## 🆘 常见问题

### Q: PR 显示 "This branch has conflicts"

**A**: 立即 rebase 解决冲突

```bash
git fetch upstream
git rebase upstream/main
# 解决冲突...
git add <files>
git rebase --continue
git push --force-with-lease
```

### Q: Greptile 指出 CHANGELOG 重复

**A**: 删除重复项并提交

```bash
# 编辑 CHANGELOG.md 删除重复行
git add CHANGELOG.md
git commit --amend  # 或新提交
git push --force-with-lease
```

### Q: Aisle Security 指出安全问题

**A**: **立即修复**（优先级最高）

```bash
# 1. 评估风险
# 2. 立即修复
# 3. 添加测试
# 4. 提交并推送
# 5. @Aisle 确认已修复
```

### Q: PR 长时间未合并

**A**: 礼貌地 ping 维护者

```markdown
@maintainers Gentle ping on this PR. All review feedback has been addressed.
Is there anything else needed for merge? 🙏
```

---

## 📚 相关资源

- [PR 模板](PULL_REQUEST_TEMPLATE.md)
- [审查响应模板](PR_REVIEW_RESPONSE_TEMPLATES.md)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [OpenClaw 贡献指南](../CONTRIBUTING.md)

---

**记住**: 快速响应审查是 PR 成功合并的关键！目标是在 **1 小时内** 响应所有审查意见。
