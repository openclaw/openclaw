# PR 自动监控配置

## 🎯 目标

每小时自动监控一次所有开放的 PR，发现问题并自动提醒优化。

---

## 📋 配置详情

### 监控脚本

**位置**: `scripts/monitor-my-prs.sh`

**功能**:

- 获取所有开放的 PR
- 检查合并状态（CLEAN/DIRTY/BEHIND）
- 检查审查状态（APPROVED/CHANGES_REQUESTED）
- 检测 bot 审查（Greptile/Aisle/Codex）
- 生成详细报告
- 提供修复建议

### Cron 配置

**频率**: 每小时一次（整点执行）

**Cron 表达式**: `0 * * * *`

**日志**: `/tmp/pr-monitor.log`

**报告**: `memory/pr-monitor-YYYY-MM-DD.md`

---

## 🔧 手动安装

如果自动配置失败，手动执行：

```bash
# 1. 添加 cron 任务
crontab -e

# 2. 添加以下行
0 * * * * /Users/hope/IdeaProjects/openclaw/scripts/monitor-my-prs.sh >> /tmp/pr-monitor.log 2>&1

# 3. 验证
crontab -l
```

---

## 📊 监控内容

### 1. 合并状态检查

| 状态    | 含义          | 行动            |
| ------- | ------------- | --------------- |
| CLEAN   | 可以直接合并  | ✅ 等待合并     |
| DIRTY   | 有冲突        | ❌ 立即 rebase  |
| BEHIND  | 落后 upstream | ⚠️ 同步最新代码 |
| BLOCKED | 需要审查      | ⚠️ 响应审查     |
| UNKNOWN | 状态不明      | 🔍 手动检查     |

### 2. 审查状态检查

| 状态              | 含义     | 行动          |
| ----------------- | -------- | ------------- |
| APPROVED          | 已批准   | ✅ 等待合并   |
| CHANGES_REQUESTED | 需要修改 | ❌ 立即修复   |
| COMMENTED         | 有评论   | ⚠️ 响应评论   |
| REVIEW_REQUIRED   | 等待审查 | ⏳ 等待审查者 |

### 3. Bot 审查检测

- **Greptile**: 代码质量建议
- **Aisle Security**: 安全问题（最高优先级）
- **Codex**: 代码审查建议

---

## 📈 报告格式

每小时生成一份报告：

```markdown
# PR 监控报告 - 2026-03-14 18:00

## 监控概览

- 作者：Linux2010
- 仓库：openclaw/openclaw
- 开放 PR 数量：3
- 监控时间：2026-03-14 18:00:00

## PR 状态详情

### PR #45813: fix(ui): prevent empty state overlay...

- 合并状态：CLEAN
- 审查状态：COMMENTED
- 创建时间：2026-03-14T06:58:17Z

#### 📊 统计

- 审查数量：2
- 评论数量：1

#### 🤖 Bot 审查

- Greptile: 1 条未解决
- Aisle Security: 0 条未解决

**行动**: 使用 `.github/PR_REVIEW_RESPONSE_TEMPLATES.md` 立即响应！

---

## 下一步行动

根据上述检查结果，按优先级处理：

1. **紧急** (立即处理):
   - 有合并冲突的 PR
   - Aisle Security 审查意见

2. **高优先级** (<30 分钟):
   - Greptile 审查意见
   - 审查要求修改

3. **中优先级** (<1 小时):
   - 落后 upstream
   - Codex 审查意见

4. **低优先级** (<2 小时):
   - 人类审查者评论
```

---

## 🚨 通知机制

### 发现问题时

脚本会：

1. 在报告中标记问题
2. 提供详细修复步骤
3. 返回非零退出码（可用于触发通知）

### 集成通知（可选）

编辑 `scripts/monitor-my-prs.sh`，在末尾添加：

```bash
# Telegram 通知
if [ "$NEEDS_ATTENTION" -gt 0 ]; then
  curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/sendMessage" \
    -d "chat_id=<CHAT_ID>" \
    -d "text=⚠️ 发现 $NEEDS_ATTENTION 个 PR 问题需要处理！"
fi
```

---

## 🔍 手动运行

随时手动运行监控：

```bash
cd /Users/hope/IdeaProjects/openclaw
./scripts/monitor-my-prs.sh
```

查看最新报告：

```bash
cat memory/pr-monitor-$(date +%Y-%m-%d).md
```

---

## 📊 查看日志

```bash
# 查看最新日志
tail -50 /tmp/pr-monitor.log

# 搜索错误
grep -i "error\|failed" /tmp/pr-monitor.log

# 查看历史报告
ls -lt memory/pr-monitor-*.md | head -10
```

---

## ⚙️ 自定义配置

### 修改监控频率

编辑 crontab：

```bash
crontab -e
```

**示例**:

- 每 30 分钟：`*/30 * * * *`
- 每 2 小时：`0 */2 * * *`
- 每天 9 点：`0 9 * * *`

### 修改监控作者

编辑脚本，修改：

```bash
AUTHOR="YourGitHubUsername"
```

### 修改监控仓库

编辑脚本，修改：

```bash
REPO="owner/repo"
```

---

## 🎯 成功标准

监控系统的目标是确保：

- ✅ 所有 PR 保持 CLEAN 状态
- ✅ 审查响应时间 <30 分钟
- ✅ 无遗留的 bot 审查
- ✅ 合并成功率 >80%

---

## 📚 相关资源

- [PR 模板](PULL_REQUEST_TEMPLATE.md)
- [审查响应模板](PR_REVIEW_RESPONSE_TEMPLATES.md)
- [提交检查清单](PR_SUBMISSION_CHECKLIST.md)
- [成功模式分析](../memory/2026-03-14-pr-merge-success-patterns.md)

---

**配置时间**: 2026-03-14  
**配置者**: @Linux2010  
**下次检查**: 每小时自动执行
