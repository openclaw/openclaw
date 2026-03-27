# HEARTBEAT.md - 自动监测配置

## 🎯 Issue/PR 修复监测任务

### 监测频率
- **PR CI 状态：** 每 30 分钟检查一次
- **Issue 分析：** 每天检查一次（上午 10:00）
- **工作时间（8:00-22:00）：** 每 15 分钟检查 PR 状态

### 监测内容

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

## 🔧 排查 Bug 和提交 PR 的标准流程

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

---

## 📝 配置记录

### Cron 定时任务
- **PR CI 监测：** `*/30 * * * * /home/w/.openclaw/workspace/scripts/monitor-pr-ci.sh`
- **Issue 监测：** `0 10 * * * /home/w/.openclaw/workspace/scripts/monitor-issues.sh`（每天上午 10 点）
- **日志：** `/home/w/.openclaw/workspace/memory/pr-ci-monitor.log` 和 `issue-monitor.log`

### ⚠️ 重要教训

**核心原则：保证 main 和 PR 纯净**

**备份策略：**
- 重要文件（IDENTITY.md, USER.md, HEARTBEAT.md）定期备份到 memory/
- 使用 git 版本控制或外部备份
- 避免在 rebase 时丢失关键配置

---

## 📊 当前统计
- 监测中 PR：待更新
- 可合并 PR：待更新
- 等待 CI：待更新
- 已关闭：待更新
- 已修复 Issue：待更新

---

*最后更新：2026-03-27 23:46*
