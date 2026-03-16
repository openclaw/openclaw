# PR 自动监控 - 快速启动指南

## ✅ 配置完成！

PR 自动监控系统已配置完成，从现在开始：

- **监控频率**: 每小时一次（整点执行）
- **监控对象**: 所有你 (@Linux2010) 在 openclaw/openclaw 的开放 PR
- **报告位置**: `memory/pr-monitor-YYYY-MM-DD.md`
- **日志位置**: `/tmp/pr-monitor.log`

---

## 🚀 首次运行结果

```
📊 发现 6 个开放的 PR

PR #45813: fix(ui): prevent empty state overlay...
   ✅ 合并状态：CLEAN
   ⚠️ 有未解决的 bot 审查 (Greptile: 1, Aisle: 0)
   💡 建议：立即响应并修复

PR #44726: fix(fs-safe): sync to disk before stat...
   ⚠️ 合并状态：UNKNOWN
   💡 建议：手动检查状态

PR #43703: fix: deliver inter-session replies...
   ⚠️ 合并状态：UNKNOWN
   ⚠️ 有未解决的 bot 审查 (Greptile: 1, Aisle: 0)

PR #43269: fix: persist outbound messages...
   ⚠️ 合并状态：UNKNOWN
   ⚠️ 有未解决的 bot 审查 (Greptile: 1, Aisle: 0)
```

---

## 📋 立即行动项

根据首次监控结果，需要处理：

### 紧急 (<1 小时)

1. **PR #45813** - 响应 Greptile 审查

   ```bash
   # 查看审查意见
   gh pr view 45813 --json reviews

   # 使用响应模板
   cat .github/PR_REVIEW_RESPONSE_TEMPLATES.md
   ```

2. **PR #43703** - 响应 Greptile 审查
3. **PR #43269** - 响应 Greptile 审查

### 高优先级 (<2 小时)

4. **PR #44726** - 检查 UNKNOWN 状态原因

---

## 🔍 手动运行监控

随时手动检查：

```bash
cd /Users/hope/IdeaProjects/openclaw
./scripts/monitor-my-prs.sh
```

查看最新报告：

```bash
cat memory/pr-monitor-$(date +%Y-%m-%d).md
```

---

## 📊 监控报告示例

每小时会生成类似这样的报告：

```markdown
# PR 监控报告 - 2026-03-14 18:00

## PR #45813: fix(ui): prevent empty state overlay...

- 合并状态：CLEAN
- 审查状态：COMMENTED
- 审查数量：2

#### 🤖 Bot 审查

- Greptile: 1 条未解决
- Aisle Security: 0 条未解决

**行动**: 使用 `.github/PR_REVIEW_RESPONSE_TEMPLATES.md` 立即响应！

---

## 下一步行动

1. **紧急** (立即处理):
   - PR #45813 - Greptile 审查

2. **高优先级** (<30 分钟):
   - PR #43703 - Greptile 审查

3. **中优先级** (<1 小时):
   - PR #43269 - Greptile 审查
```

---

## ⚙️ Cron 配置

**Cron 任务**: `0 * * * *`（每小时整点执行）

**查看 cron**:

```bash
crontab -l
```

**输出**:

```
0 * * * * /Users/hope/IdeaProjects/openclaw/scripts/monitor-my-prs.sh >> /tmp/pr-monitor.log 2>&1
```

---

## 🎯 监控目标

通过自动监控，确保：

- ✅ 所有 PR 保持 CLEAN 状态
- ✅ 审查响应时间 <30 分钟
- ✅ 无遗留的 bot 审查
- ✅ 合并成功率 >80%

---

## 📚 相关资源

| 资源         | 位置                                             |
| ------------ | ------------------------------------------------ |
| 监控脚本     | `scripts/monitor-my-prs.sh`                      |
| 审查响应模板 | `.github/PR_REVIEW_RESPONSE_TEMPLATES.md`        |
| PR 模板      | `.github/PULL_REQUEST_TEMPLATE.md`               |
| 提交检查清单 | `.github/PR_SUBMISSION_CHECKLIST.md`             |
| 成功模式分析 | `memory/2026-03-14-pr-merge-success-patterns.md` |

---

## 🆘 故障排除

### 问题：脚本执行失败

```bash
# 检查权限
chmod +x scripts/monitor-my-prs.sh

# 手动运行查看错误
./scripts/monitor-my-prs.sh

# 检查日志
tail -50 /tmp/pr-monitor.log
```

### 问题：cron 未执行

```bash
# 检查 cron 状态
crontab -l

# 重新添加
echo "0 * * * * /Users/hope/IdeaProjects/openclaw/scripts/monitor-my-prs.sh" | crontab -

# 验证
crontab -l
```

### 问题：gh 命令失败

```bash
# 检查 gh 认证
gh auth status

# 重新认证
gh auth login
```

---

## 📈 效果追踪

每天查看监控报告，追踪改进：

```bash
# 查看本周所有报告
ls -lt memory/pr-monitor-*.md | head -7

# 统计问题解决率
grep -c "✅" memory/pr-monitor-*.md
grep -c "⚠️" memory/pr-monitor-*.md
```

**目标**:

- 每日平均问题数递减
- 问题解决时间 <1 小时
- 合并成功率 >80%

---

**配置时间**: 2026-03-14 18:30  
**配置者**: @Linux2010  
**下次监控**: 下一个整点（19:00）
