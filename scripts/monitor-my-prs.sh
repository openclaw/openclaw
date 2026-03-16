#!/bin/bash
# PR 自我监控脚本 - 每小时检查一次开放的 PR
# 用法：./scripts/monitor-my-prs.sh

set -e

REPO="openclaw/openclaw"
AUTHOR="Linux2010"
WORKSPACE="/Users/hope/.openclaw/agents/coding/workspace"
MEMORY_FILE="$WORKSPACE/memory/pr-monitor-$(date +%Y-%m-%d).md"

echo "🔍 开始监控 $AUTHOR 在 $REPO 的开放 PR..."
echo "时间：$(date)"
echo ""

# 获取所有开放的 PR
PR_LIST=$(gh pr list --repo "$REPO" --author "$AUTHOR" --state open --json number,title,createdAt,mergeStateStatus,reviewDecision --limit 20)

if [ -z "$PR_LIST" ] || [ "$PR_LIST" = "[]" ]; then
  echo "✅ 没有开放的 PR"
  exit 0
fi

# 解析 PR 数量
PR_COUNT=$(echo "$PR_LIST" | jq 'length')
echo "📊 发现 $PR_COUNT 个开放的 PR"
echo ""

# 初始化报告
cat > "$MEMORY_FILE" << EOF
# PR 监控报告 - $(date +%Y-%m-%d %H:%M)

## 监控概览

- 作者：$AUTHOR
- 仓库：$REPO
- 开放 PR 数量：$PR_COUNT
- 监控时间：$(date)

## PR 状态详情

EOF

# 逐个检查 PR
echo "$PR_LIST" | jq -r '.[] | "\(.number)|\(.title)|\(.mergeStateStatus)|\(.reviewDecision)"' | while IFS='|' read -r PR_NUMBER PR_TITLE MERGE_STATUS REVIEW_STATUS; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📌 PR #$PR_NUMBER: $PR_TITLE"
  echo "   合并状态：$MERGE_STATUS"
  echo "   审查状态：$REVIEW_STATUS"
  
  # 写入报告
  cat >> "$MEMORY_FILE" << EOF
### PR #$PR_NUMBER: $PR_TITLE

- 合并状态：$MERGE_STATUS
- 审查状态：$REVIEW_STATUS
- 创建时间：$(gh pr view $PR_NUMBER --repo "$REPO" --json createdAt --jq '.createdAt')

EOF
  
  # 检查问题并给出建议
  ISSUES_FOUND=0
  
  # 问题 1: 有合并冲突
  if [ "$MERGE_STATUS" = "DIRTY" ] || [ "$MERGE_STATUS" = "CONFLICTING" ]; then
    echo "   ❌ 问题：有合并冲突"
    echo "   💡 建议：立即 rebase upstream/main"
    echo ""
    
    cat >> "$MEMORY_FILE" << EOF
#### ⚠️ 发现问题

- [ ] **有合并冲突** - 需要立即解决

#### 🔧 修复步骤

\`\`\`bash
cd /Users/hope/IdeaProjects/openclaw
git fetch upstream
git rebase upstream/main
# 解决冲突...
git add <files>
git rebase --continue
git push --force-with-lease origin fix/branch-name
\`\`\`

EOF
    ISSUES_FOUND=1
  fi
  
  # 问题 2: 审查未解决
  if [ "$REVIEW_STATUS" = "CHANGES_REQUESTED" ]; then
    echo "   ❌ 问题：审查要求修改"
    echo "   💡 建议：立即响应审查意见并修复"
    echo ""
    
    cat >> "$MEMORY_FILE" << EOF
#### ⚠️ 发现问题

- [ ] **审查要求修改** - 需要在 30 分钟内响应

#### 🔧 修复步骤

1. 查看审查意见：\`gh pr view $PR_NUMBER --repo "$REPO" --json reviews\`
2. 使用审查响应模板：\`.github/PR_REVIEW_RESPONSE_TEMPLATES.md\`
3. 修复问题并提交
4. @审查者确认已修复

EOF
    ISSUES_FOUND=1
  fi
  
  # 问题 3: 落后 upstream
  if [ "$MERGE_STATUS" = "BEHIND" ]; then
    echo "   ⚠️ 问题：落后 upstream"
    echo "   💡 建议：rebase 到最新 upstream/main"
    echo ""
    
    cat >> "$MEMORY_FILE" << EOF
#### ⚠️ 发现问题

- [ ] **落后 upstream** - 需要同步最新代码

#### 🔧 修复步骤

\`\`\`bash
git fetch upstream
git rebase upstream/main
git push --force-with-lease origin fix/branch-name
\`\`\`

EOF
    ISSUES_FOUND=1
  fi
  
  # 获取审查数量
  REVIEW_COUNT=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json reviews --jq '.reviews | length' 2>/dev/null || echo "0")
  COMMENT_COUNT=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json comments --jq '.comments | length' 2>/dev/null || echo "0")
  
  echo "   📝 审查数量：$REVIEW_COUNT"
  echo "   💬 评论数量：$COMMENT_COUNT"
  
  cat >> "$MEMORY_FILE" << EOF
#### 📊 统计

- 审查数量：$REVIEW_COUNT
- 评论数量：$COMMENT_COUNT

EOF
  
  # 检查是否有未解决的 bot 审查
  if [ "$REVIEW_COUNT" -gt 0 ]; then
    echo "   🔍 检查 bot 审查..."
    
    # 获取 Greptile 审查
    GREPTILE_REVIEWS=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json reviews --jq '[.reviews[] | select(.author.login == "greptile-apps" and .state == "COMMENTED")] | length' 2>/dev/null || echo "0")
    
    # 获取 Aisle Security 审查
    AISLE_REVIEWS=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json reviews --jq '[.reviews[] | select(.author.login == "aisle-research-bot" and .state == "COMMENTED")] | length' 2>/dev/null || echo "0")
    
    if [ "$GREPTILE_REVIEWS" -gt 0 ] || [ "$AISLE_REVIEWS" -gt 0 ]; then
      echo "   ⚠️ 有未解决的 bot 审查 (Greptile: $GREPTILE_REVIEWS, Aisle: $AISLE_REVIEWS)"
      echo "   💡 建议：立即响应并修复"
      echo ""
      
      cat >> "$MEMORY_FILE" << EOF
#### 🤖 Bot 审查

- Greptile: $GREPTILE_REVIEWS 条未解决
- Aisle Security: $AISLE_REVIEWS 条未解决

**行动**: 使用 \`.github/PR_REVIEW_RESPONSE_TEMPLATES.md\` 立即响应！

EOF
    fi
  fi
  
  # 如果没有问题
  if [ "$ISSUES_FOUND" -eq 0 ] && [ "$MERGE_STATUS" = "CLEAN" ] && [ "$REVIEW_STATUS" = "APPROVED" ]; then
    echo "   ✅ 状态良好，等待合并"
    
    cat >> "$MEMORY_FILE" << EOF
#### ✅ 状态

所有检查通过，等待维护者合并。

EOF
  fi
  
  echo ""
done

# 添加总结
cat >> "$MEMORY_FILE" << EOF
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

## 监控配置

- 频率：每小时一次
- 通知：查看此报告
- 自动化脚本：\`scripts/monitor-my-prs.sh\`

---

**下次监控**: $(date -v+1H +%Y-%m-%d\ %H:%M:%S)
EOF

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📄 完整报告已保存至：$MEMORY_FILE"
echo "⏰ 下次监控：1 小时后"
echo ""

# 如果有问题，显示摘要
echo "📊 监控摘要:"
echo "   - 开放 PR: $PR_COUNT"
echo "   - 需要关注：$(grep -c "❌\|⚠️" "$MEMORY_FILE" || echo 0)"
echo "   - 状态良好：$(grep -c "✅ 状态良好" "$MEMORY_FILE" || echo 0)"
echo ""

# 🔄 更新 PR 跟踪清单
echo "🔄 正在更新 PR 跟踪清单..."

TRACKING_FILE="/Users/hope/IdeaProjects/openclaw/pr-tracking-list.md"
TIMESTAMP=$(date +"%Y-%m-%d %H:%M")

# 统计各状态 PR 数量
CLEAN_COUNT=$(echo "$PR_LIST" | jq '[.[] | select(.mergeStateStatus == "CLEAN")] | length')
DIRTY_COUNT=$(echo "$PR_LIST" | jq '[.[] | select(.mergeStateStatus == "DIRTY" or .mergeStateStatus == "CONFLICTING")] | length')
BEHIND_COUNT=$(echo "$PR_LIST" | jq '[.[] | select(.mergeStateStatus == "BEHIND")] | length')
UNKNOWN_COUNT=$(echo "$PR_LIST" | jq '[.[] | select(.mergeStateStatus == "UNKNOWN" or .mergeStateStatus == "BLOCKED")] | length')

# 统计审查情况
GREPTILE_UNRESOLVED=0
AISLE_UNRESOLVED=0
TOTAL_COMMENTS=0

for PR_DATA in $(echo "$PR_LIST" | jq -r '.[] | @base64'); do
  _jq() {
    echo ${PR_DATA} | base64 --decode | jq -r ${1}
  }
  
  PR_NUM=$(_jq '.number')
  
  # 获取 Greptile 审查
  GREPTILE=$(gh pr view "$PR_NUM" --repo "$REPO" --json reviews --jq '[.reviews[] | select(.author.login == "greptile-apps" and .state == "COMMENTED")] | length' 2>/dev/null || echo "0")
  GREPTILE_UNRESOLVED=$((GREPTILE_UNRESOLVED + GREPTILE))
  
  # 获取 Aisle 审查
  AISLE=$(gh pr view "$PR_NUM" --repo "$REPO" --json reviews --jq '[.reviews[] | select(.author.login == "aisle-research-bot" and .state == "COMMENTED")] | length' 2>/dev/null || echo "0")
  AISLE_UNRESOLVED=$((AISLE_UNRESOLVED + AISLE))
  
  # 获取评论数
  COMMENTS=$(gh pr view "$PR_NUM" --repo "$REPO" --json comments --jq '.comments | length' 2>/dev/null || echo "0")
  TOTAL_COMMENTS=$((TOTAL_COMMENTS + COMMENTS))
done

# 生成 PR 跟踪清单
cat > "$TRACKING_FILE" << EOF
# PR 跟踪清单 - $TIMESTAMP (自动更新)

## 📊 当前活跃 PR ($PR_COUNT 个)

EOF

# 添加每个 PR 的详情
echo "$PR_LIST" | jq -r '.[] | "\(.number)|\(.title)|\(.mergeStateStatus)|\(.reviewDecision)"' | while IFS='|' read -r PR_NUMBER PR_TITLE MERGE_STATUS REVIEW_STATUS; do
  # 获取详细信息
  CREATED_AT=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json createdAt --jq '.createdAt' 2>/dev/null | cut -d'T' -f1)
  REVIEW_COUNT=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json reviews --jq '.reviews | length' 2>/dev/null || echo "0")
  COMMENT_COUNT=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json comments --jq '.comments | length' 2>/dev/null || echo "0")
  
  # 检查 bot 审查
  GREPTILE_COUNT=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json reviews --jq '[.reviews[] | select(.author.login == "greptile-apps" and .state == "COMMENTED")] | length' 2>/dev/null || echo "0")
  AISLE_COUNT=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json reviews --jq '[.reviews[] | select(.author.login == "aisle-research-bot" and .state == "COMMENTED")] | length' 2>/dev/null || echo "0")
  
  # 确定状态图标
  case "$MERGE_STATUS" in
    CLEAN) STATUS_ICON="🟢" ;;
    DIRTY|CONFLICTING) STATUS_ICON="🔴" ;;
    BEHIND) STATUS_ICON="🟡" ;;
    *) STATUS_ICON="🟡" ;;
  esac
  
  # 写入 PR 详情
  cat >> "$TRACKING_FILE" << EOF
### PR #$PR_NUMBER - $PR_TITLE $STATUS_ICON
- **Issue**: #$PR_NUMBER | **PR**: https://github.com/$REPO/pull/$PR_NUMBER
- **作者**: @$AUTHOR
- **创建时间**: $CREATED_AT
- **合并状态**: $MERGE_STATUS
- **审查状态**: $REVIEW_STATUS
- **审查数量**: $REVIEW_COUNT
  - Greptile: $GREPTILE_COUNT 条未解决
  - Aisle Security: $AISLE_COUNT 条未解决
- **评论数量**: $COMMENT_COUNT
- **状态**: $(if [ "$MERGE_STATUS" = "CLEAN" ] && [ "$REVIEW_STATUS" = "APPROVED" ]; then echo "🟢 可合并"; elif [ "$GREPTILE_COUNT" -gt 0 ] || [ "$AISLE_COUNT" -gt 0 ]; then echo "🔴 需要响应审查"; else echo "🟡 等待审查"; fi)

EOF
done

# 添加统计信息
cat >> "$TRACKING_FILE" << EOF
## 📈 统计

| 状态 | 数量 | 百分比 |
|------|------|--------|
| 🟢 可合并 (CLEAN) | $CLEAN_COUNT | $(echo "scale=1; $CLEAN_COUNT * 100 / $PR_COUNT" | bc)% |
| 🟡 需要审查响应 | $UNKNOWN_COUNT | $(echo "scale=1; $UNKNOWN_COUNT * 100 / $PR_COUNT" | bc)% |
| 🔴 有冲突 (DIRTY) | $DIRTY_COUNT | $(echo "scale=1; $DIRTY_COUNT * 100 / $PR_COUNT" | bc)% |
| ⚠️ 落后 upstream | $BEHIND_COUNT | $(echo "scale=1; $BEHIND_COUNT * 100 / $PR_COUNT" | bc)% |
| **总计** | **$PR_COUNT** | **100%** |

### 审查情况
- **Greptile 未解决**: $GREPTILE_UNRESOLVED 条
- **Aisle Security 未解决**: $AISLE_UNRESOLVED 条
- **人类审查者评论**: $TOTAL_COMMENTS 条

### 合并成功率预测
- **当前**: $(echo "scale=1; $CLEAN_COUNT * 100 / $PR_COUNT" | bc)% ($CLEAN_COUNT/$PR_COUNT)
- **目标**: 80%+
- **需要改进**: $(if [ $CLEAN_COUNT -lt $((PR_COUNT * 8 / 10)) ]; then echo "响应审查 + 解决冲突"; else echo "保持当前状态 ✅"; fi)

---

## 🚨 立即行动项

### 紧急 (<30 分钟)
$(echo "$PR_LIST" | jq -r '.[] | select(.mergeStateStatus == "CLEAN") | "- **PR #\(.number)** - 等待审查，需立即响应"')

### 高优先级 (<1 小时)
$(echo "$PR_LIST" | jq -r '.[] | select(.mergeStateStatus == "DIRTY" or .mergeStateStatus == "CONFLICTING") | "- **PR #\(.number)** - 有冲突，立即 rebase"')
$(echo "$PR_LIST" | jq -r '.[] | select(.mergeStateStatus == "BEHIND") | "- **PR #\(.number)** - 落后 upstream，同步最新代码"')

---

## 🎯 改进计划

### 当前问题
$(if [ $CLEAN_COUNT -lt $((PR_COUNT * 8 / 10)) ]; then echo "- ❌ 审查响应时间：无限期（目标 <30 分钟）"; fi)
$(if [ $DIRTY_COUNT -gt 0 ]; then echo "- ❌ 冲突解决：$DIRTY_COUNT 个 PR 有冲突（目标 0）"; fi)

### 已实施改进
- ✅ 创建 PR 模板（\`.github/PULL_REQUEST_TEMPLATE.md\`）
- ✅ 创建审查响应模板（\`.github/PR_REVIEW_RESPONSE_TEMPLATES.md\`）
- ✅ 创建提交检查清单（\`.github/PR_SUBMISSION_CHECKLIST.md\`）
- ✅ 设置 PR 监控（每小时自动检查）
- ✅ 更新核心记忆（\`MEMORY.md\`）

### 目标
- 审查响应 <30 分钟
- 所有 PR 保持 CLEAN 状态
- 合并成功率 0% → 80%+

---

## 🔗 相关资源

- [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)
- [审查响应模板](.github/PR_REVIEW_RESPONSE_TEMPLATES.md)
- [提交检查清单](.github/PR_SUBMISSION_CHECKLIST.md)
- [PR 监控配置](.github/PR_MONITORING_QUICKSTART.md)
- [成功模式分析](memory/2026-03-14-pr-merge-success-patterns.md)

---

*最后更新：$TIMESTAMP*  
*下次自动监控：1 小时后*
EOF

echo "✅ PR 跟踪清单已更新：$TRACKING_FILE"
echo ""

# 返回需要关注的 PR 数量
NEEDS_ATTENTION=$(grep -c "❌\|⚠️" "$MEMORY_FILE" || echo 0)
if [ "$NEEDS_ATTENTION" -gt 0 ]; then
  echo "⚠️  发现 $NEEDS_ATTENTION 个问题需要处理！"
  echo "👉 查看完整报告：$MEMORY_FILE"
  echo "👉 查看 PR 跟踪清单：$TRACKING_FILE"
  exit 1
else
  echo "✅ 所有 PR 状态良好！"
  exit 0
fi
