# 工作流程持久化

## 🔧 PR 排查和提交流程 (2026-03-28 祥哥制定)

### 最简流程（只记 3 步）

```bash
# 1️⃣ 修复前：同步本地 main 到上游
git checkout main
git pull origin main  # origin = openclaw/openclaw

# 2️⃣ 创建分支：从干净的 main 创建
git checkout -b fix/issue-xxx

# 3️⃣ 提交前：验证
git status           # 确认修改的文件
git log --oneline    # 确认只有一个 commit
```

### 🚫 一条红线

- **fork 的 main 只在 PR 被合并后才同步**
- 平时不管它，让它落后于上游

### 完整示例

```bash
# 修复 #53386
git checkout main && git pull origin main
git checkout -b fix/53386-whatsapp-fromme
# 修改代码 → 测试
git add . && git commit -m "fix(whatsapp): filter fromMe (#53386)"
git push fork fix/53386-whatsapp-fromme
gh pr create --title "fix: ..." --body "Fixes #53386"

# === PR 合并后 ===
git checkout main && git pull origin main && git push fork main
```

### 错误案例（避免重蹈覆辙）

- #53608 - 包含了其他 PR 的内容，被管理员关闭
- #53492、#53407 - 因包含其他 PR 内容被管理员关闭

### 修复原则

- ✅ 从干净的 main 分支创建
- ✅ 每个 PR 只修复一个 issue
- ✅ 每个 PR 只有一个 commit
- ✅ fork 的 main 未同步（只在合并后才同步）
- ✅ 活跃 PR 不超过 10 个（否则 bot 会关闭新 PR）

---

## 🤖 GitHub Issue/PR 监控流程

### 监控频率

- **PR CI 状态：** 每 30 分钟检查一次
- **Issue 分析：** 每天检查一次（上午 10:00）
- **工作时间（8:00-22:00）：** 每 15 分钟检查 PR 状态

### 监控内容

1. **CI 状态变化**
   - 检查负责的 PR 的 CI 是否变绿
   - 检查其他 PR 的 CI 是否自动变绿

2. **评论回复**
   - 检查维护者是否有新评论
   - 检查是否需要回复

3. **PR 状态变化**
   - 检查是否有 PR 被合并
   - 检查是否有 PR 被关闭

### 行动规则

**如果 CI 变绿：**

1. 立即通知祥哥
2. 在 PR 下添加评论说明可以合并了（不要同时 ping 多位维护者）

**如果维护者评论：**

1. 立即回复（如果需要）
2. 根据评论采取相应行动
3. ⚠️ **注意：** 不要同时 @ 多位维护者，会被认为是 spam

**如果有 PR 被合并：**

1. 记录到 memory/ 日期文件
2. 更新剩余 PR 的状态

---

## 📝 记忆持久化流程

### 每日记忆（自动）

```bash
# 每天 23:59 自动创建
memory/YYYY-MM-DD.md
```

**内容包含：**

- 当天修复的 bug
- 创建的 PR
- 重要对话和决策
- 祥哥的指示和规则

### 提交到私有仓库（每次记忆更新后）

```bash
cd /home/w/.openclaw/workspace/memory
git add .
git commit -m "memory: YYYY-MM-DD 重要事件"
git push origin main
```

### 每周汇总（周末手动）

```bash
# 1. 查看本周记忆
git log --since="7 days ago" -- memory/

# 2. 汇总到 MEMORY.md
# 编辑 MEMORY.md，添加本周摘要

# 3. 提交
git add MEMORY.md
git commit -m "summary: week 2026-W13"
git push origin main
```

---

## 🔐 私密存储规则

### 什么需要私密存储

- ✅ 日常记忆 (memory/YYYY-MM-DD.md)
- ✅ 行为准则 (CODE_OF_CONDUCT.md)
- ✅ 工作流程 (WORKFLOW.md)
- ✅ 监控日志 (issue-monitor.log, pr-ci-monitor.log)

### 什么可以公开

- ✅ 代码修复
- ✅ PR 和 Issue
- ✅ 公开的技术文档

### 存储位置

- **私有仓库:** https://github.com/w-sss/openclaw-memory-private
- **访问权限:** 仅 w-sss (祥哥) 可访问
- **备份策略:** GitHub 云端 + 本地 .git 历史

---

## ⚠️ 重要教训记录

### 2026-03-28: PR 提交规范

- 问题：#55883 因活跃 PR>10 个被 bot 关闭
- 教训：提交前检查活跃 PR 数量，超过 10 个先关闭已合并的

### 2026-03-27: 微信渠道配置

- 问题：配置丢失，需要重新配置
- 教训：重要配置要记录到 memory/ 并持久化

### 2026-03-27: 记忆丢失

- 问题：IDENTITY.md 和 USER.md 在 rebase 时丢失
- 教训：重要文件要备份到 memory/ 并 git 提交

---

## 📖 随时查阅

```bash
# 查看行为准则
cat /home/w/.openclaw/workspace/memory/CODE_OF_CONDUCT.md

# 查看工作流程
cat /home/w/.openclaw/workspace/memory/WORKFLOW.md

# 查看今天记忆
cat /home/w/.openclaw/workspace/memory/$(date +%Y-%m-%d).md

# GitHub API 查看（需要祥哥的 token）
curl -H "Authorization: token YOUR_TOKEN" \
  https://api.github.com/repos/w-sss/openclaw-memory-private/contents/CODE_OF_CONDUCT.md
```

---

_最后更新：2026-03-28 00:26_
