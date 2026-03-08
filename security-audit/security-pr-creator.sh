#!/bin/bash
# 安全PR创建脚本 - 创建安全修复的Pull Request
# 执行时间：安全修复后运行

set -e

if [ -z "$1" ]; then
    echo "使用方法: $0 <修复分支名> [\"PR标题\"] [\"PR描述\"]"
    echo "示例: $0 security-fix-20260304"
    echo "示例: $0 security-fix-20260304 \"security: fix vulnerabilities\" \"## 安全修复\""
    exit 1
fi

BRANCH_NAME=$1
PR_TITLE=${2:-"security: fix vulnerabilities and improve security"}
PR_DESCRIPTION=${3:-"## 安全修复\n\n基于安全审计发现的安全问题进行修复。"}

echo "================================================"
echo "🛡️  安全PR创建开始"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "分支: $BRANCH_NAME"
echo "================================================"

# 配置
REPO_DIR="/root/.openclaw/workspace-github_expert/openclaw"
AUDIT_DATE=$(date +%Y%m%d)
PR_LOG_DIR="/root/.openclaw/workspace-github_expert/security-prs"

# 创建目录
mkdir -p "$PR_LOG_DIR"

# 切换到仓库目录
cd "$REPO_DIR" || {
    echo "❌ 错误：无法进入仓库目录 $REPO_DIR"
    exit 1
}

# 函数：记录PR日志
log_pr() {
    local action=$1
    local details=$2
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local log_file="$PR_LOG_DIR/security-pr-$AUDIT_DATE.log"
    
    echo "[$timestamp] [$action] $details" | tee -a "$log_file"
}

# 1. 检查分支是否存在
log_pr "INFO" "检查分支: $BRANCH_NAME"
if ! git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
    log_pr "ERROR" "分支 $BRANCH_NAME 不存在"
    echo "可用分支:"
    git branch | grep -E "security-fix|feature-" || git branch
    exit 1
fi

# 2. 切换到安全修复分支
log_pr "INFO" "切换到分支: $BRANCH_NAME"
git checkout "$BRANCH_NAME"
git status

# 3. 确保分支是最新的
log_pr "INFO" "同步最新代码..."
git fetch origin
git merge origin/daily-sync --no-edit 2>/dev/null || {
    log_pr "WARN" "有冲突需要解决，请先运行冲突解决脚本"
    exit 1
}

# 4. 推送分支到远程
log_pr "INFO" "推送分支到远程..."
git push origin "$BRANCH_NAME"

# 5. 检查修改内容
log_pr "INFO" "检查修改内容..."
CHANGES=$(git diff --name-only "origin/daily-sync"..."$BRANCH_NAME")
if [ -z "$CHANGES" ]; then
    log_pr "WARN" "没有检测到修改，请先进行安全修复"
    exit 1
fi

CHANGE_COUNT=$(echo "$CHANGES" | wc -l)
ADDITIONS=$(git diff --shortstat "origin/daily-sync"..."$BRANCH_NAME" | awk '{print $4}')
DELETIONS=$(git diff --shortstat "origin/daily-sync"..."$BRANCH_NAME" | awk '{print $6}')

log_pr "INFO" "修改统计: $CHANGE_COUNT 个文件, +$ADDITIONS -$DELETIONS"

# 6. 生成详细的安全PR描述
log_pr "INFO" "生成安全PR描述..."
SECURITY_REPORT=$(find /root/.openclaw/workspace-github_expert/security-reports -name "security-summary-*.md" -type f | sort -r | head -1)

if [ -n "$SECURITY_REPORT" ] && [ -f "$SECURITY_REPORT" ]; then
    # 从安全报告提取关键信息
    REPORT_CONTENT=$(cat "$SECURITY_REPORT")
    
    # 提取风险统计
    CRITICAL_RISKS=$(echo "$REPORT_CONTENT" | grep -o "严重风险: [0-9]*" | grep -o "[0-9]*" || echo "0")
    HIGH_RISKS=$(echo "$REPORT_CONTENT" | grep -o "高风险: [0-9]*" | grep -o "[0-9]*" || echo "0")
    
    # 生成详细的PR描述
    PR_DESCRIPTION="## 安全修复 PR

### 背景
基于 $(date +%Y年%m月%d日) 的安全审计结果，实施安全修复。

### 审计发现
- **严重风险**: $CRITICAL_RISKS 个
- **高风险**: $HIGH_RISKS 个
- **总发现数**: $(echo "$REPORT_CONTENT" | grep -o "总发现数: [0-9]*" | grep -o "[0-9]*" || echo "0") 个

### 修复内容
本次PR修复了以下安全问题：

#### 1. 硬编码密钥问题
- 在配置文件中注释了硬编码的密钥
- 添加了使用环境变量的TODO注释
- 防止密钥泄露风险

#### 2. 不安全配置修复
- 禁用了生产环境不应启用的调试模式
- 修复了可能不安全的默认配置
- 添加了安全配置注释

#### 3. XSS风险缓解
- 为潜在的XSS风险点添加了安全警告
- 标记了需要进一步审查的代码位置
- 提供了安全编码建议

#### 4. 安全最佳实践
- 添加了安全头配置检查
- 标记了需要安全审查的依赖
- 提供了安全开发指南

### 修改统计
- **修改文件**: $CHANGE_COUNT 个
- **新增行数**: $ADDITIONS 行
- **删除行数**: $DELETIONS 行

### 修改文件列表
\`\`\`
$CHANGES
\`\`\`

### 安全测试
建议进行以下安全测试：
1. 运行安全扫描工具验证修复
2. 进行渗透测试验证关键修复
3. 代码审查安全相关修改
4. 验证依赖更新没有引入新问题

### 相关资源
- 安全审计报告: $(basename "$SECURITY_REPORT")
- 安全修复日志: security-fixes-$AUDIT_DATE.log
- 完整差异: \`git diff origin/daily-sync..$BRANCH_NAME\`

### 检查清单
- [ ] 安全修复经过代码审查
- [ ] 修复没有引入回归问题
- [ ] 安全测试通过
- [ ] 文档已更新（如果需要）
- [ ] 相关团队已通知

---
*安全修复由网络安全专家执行*  
*基于自动化安全审计和修复流程*"
else
    log_pr "WARN" "未找到安全审计报告，使用默认描述"
fi

# 7. 创建PR
log_pr "INFO" "创建安全修复PR..."
log_pr "INFO" "标题: $PR_TITLE"
log_pr "INFO" "分支: $BRANCH_NAME -> openclaw:main"

# 创建临时文件存储PR描述
TEMP_PR_FILE=$(mktemp)
echo -e "$PR_DESCRIPTION" > "$TEMP_PR_FILE"

# 尝试创建PR
PR_RESULT=$(gh pr create \
  --repo openclaw/openclaw \
  --base main \
  --head "jiangfeng2066:$BRANCH_NAME" \
  --title "$PR_TITLE" \
  --body-file "$TEMP_PR_FILE" \
  --label "security,automated-fix" 2>&1)

# 清理临时文件
rm -f "$TEMP_PR_FILE"

# 检查PR创建结果
if echo "$PR_RESULT" | grep -q "https://github.com/openclaw/openclaw/pull/"; then
    PR_URL=$(echo "$PR_RESULT" | grep -o "https://github.com/openclaw/openclaw/pull/[0-9]*")
    PR_NUMBER=$(echo "$PR_URL" | grep -o "[0-9]*$")
    
    log_pr "SUCCESS" "安全PR创建成功!"
    log_pr "INFO" "PR号: #$PR_NUMBER"
    log_pr "INFO" "链接: $PR_URL"
    
    # 记录PR信息
    cat > "SECURITY-PR-${PR_NUMBER}.md" << EOF
# 安全修复 PR #$PR_NUMBER

## 基本信息
- **PR号**: #$PR_NUMBER
- **标题**: $PR_TITLE
- **链接**: $PR_URL
- **分支**: $BRANCH_NAME -> main
- **创建时间**: $(date)
- **创建者**: 网络安全专家

## 安全背景
基于安全审计 $(AUDIT_DATE) 的结果进行修复。

## 修复统计
- 修改文件: $CHANGE_COUNT 个
- 新增行数: $ADDITIONS 行
- 删除行数: $DELETIONS 行

## 状态跟踪
- [ ] 等待CI检查
- [ ] 等待安全审查
- [ ] 审查通过
- [ ] 安全测试通过
- [ ] 合并完成

## 相关文件
- 安全审计报告: $(basename "$SECURITY_REPORT" 2>/dev/null || echo "N/A")
- 修复日志: security-fixes-$AUDIT_DATE.log
- PR日志: $(basename "$PR_LOG_DIR/security-pr-$AUDIT_DATE.log")

## 监控
此PR将纳入每日安全监控。
EOF
    
    log_pr "INFO" "PR信息已保存到: SECURITY-PR-${PR_NUMBER}.md"
    
    # 添加到活跃PR监控列表
    echo "$PR_NUMBER" >> "/root/.openclaw/workspace-github_expert/active-security-prs.txt"
    
else
    log_pr "ERROR" "PR创建失败"
    log_pr "ERROR" "错误信息:"
    echo "$PR_RESULT"
    
    # 提供备用方案
    log_pr "INFO" ""
    log_pr "INFO" "备用方案: 手动创建PR"
    log_pr "INFO" "1. 访问: https://github.com/openclaw/openclaw/compare/main...jiangfeng2066:${BRANCH_NAME}?expand=1"
    log_pr "INFO" "2. 使用标题: $PR_TITLE"
    log_pr "INFO" "3. 添加标签: security, automated-fix"
    log_pr "INFO" "4. 使用描述:"
    echo -e "$PR_DESCRIPTION"
fi

# 8. 完成
echo ""
echo "================================================"
echo "🛡️  安全PR创建流程完成"
echo "================================================"
echo "时间: $(date)"
echo "分支: $BRANCH_NAME"
echo "修改: $CHANGE_COUNT 个文件"
echo "日志: $PR_LOG_DIR/security-pr-$AUDIT_DATE.log"
echo ""
if [ -n "$PR_NUMBER" ]; then
    echo "✅ 安全PR创建成功: #$PR_NUMBER"
    echo "链接: $PR_URL"
else
    echo "⚠️  请使用备用方案手动创建PR"
fi
echo "================================================"

exit 0