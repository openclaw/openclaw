#!/bin/bash
# 完整安全审计工作流 - 修复版本
# 包含错误处理和条件执行

set -e

echo "================================================"
echo "🛡️  完整安全审计工作流开始 - 手动触发"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "================================================"

# 配置
REPO_DIR="/root/.openclaw/workspace-github_expert/openclaw"
AUDIT_DATE=$(date +%Y%m%d)
LOG_DIR="/root/.openclaw/workspace-github_expert/security-audit-logs"
REPORT_DIR="/root/.openclaw/workspace-github_expert/security-reports"

# 创建目录
mkdir -p "$LOG_DIR" "$REPORT_DIR"

# 切换到仓库目录
cd "$REPO_DIR" || {
    echo "❌ 错误：无法进入仓库目录"
    exit 1
}

# 函数：记录日志
log() {
    local level=$1
    local message=$2
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local log_file="$LOG_DIR/security-workflow-$AUDIT_DATE.log"
    
    echo "[$timestamp] [$level] $message" | tee -a "$log_file"
}

# 1. 更新代码到最新
log "INFO" "步骤1: 更新代码到最新版本..."
git checkout daily-sync
git pull origin daily-sync

# 2. 运行安全审计
log "INFO" "步骤2: 运行安全审计..."
if [ -f "./security-audit/security-audit-main.sh" ]; then
    ./security-audit/security-audit-main.sh
    AUDIT_EXIT_CODE=$?
    
    if [ $AUDIT_EXIT_CODE -eq 0 ]; then
        log "SUCCESS" "安全审计完成"
    else
        log "WARN" "安全审计遇到问题，继续执行"
    fi
else
    log "ERROR" "安全审计脚本不存在"
    exit 1
fi

# 3. 检查是否有安全发现
log "INFO" "步骤3: 检查安全发现..."
FINDINGS_FILE="$REPORT_DIR/findings-$AUDIT_DATE.json"
if [ -f "$FINDINGS_FILE" ]; then
    FINDING_COUNT=$(jq '. | length' "$FINDINGS_FILE" 2>/dev/null || echo "0")
    log "INFO" "发现 $FINDING_COUNT 个安全问题"
    
    if [ "$FINDING_COUNT" -gt 0 ]; then
        # 4. 运行自动修复
        log "INFO" "步骤4: 运行自动修复..."
        if [ -f "./security-audit/security-fix-automated.sh" ]; then
            ./security-audit/security-fix-automated.sh
            FIX_EXIT_CODE=$?
            
            if [ $FIX_EXIT_CODE -eq 0 ]; then
                log "SUCCESS" "自动修复完成"
                
                # 5. 创建安全PR
                log "INFO" "步骤5: 创建安全PR..."
                BRANCH_NAME="security-fix-$AUDIT_DATE"
                
                # 检查修复分支是否存在
                if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
                    if [ -f "./security-audit/security-pr-creator.sh" ]; then
                        ./security-audit/security-pr-creator.sh "$BRANCH_NAME"
                        PR_EXIT_CODE=$?
                        
                        if [ $PR_EXIT_CODE -eq 0 ]; then
                            log "SUCCESS" "安全PR创建流程完成"
                        else
                            log "WARN" "安全PR创建遇到问题"
                        fi
                    else
                        log "ERROR" "安全PR创建脚本不存在"
                    fi
                else
                    log "INFO" "没有创建修复分支，跳过PR创建"
                fi
            else
                log "WARN" "自动修复遇到问题"
            fi
        else
            log "ERROR" "自动修复脚本不存在"
        fi
    else
        log "INFO" "没有发现安全问题，跳过修复和PR创建"
    fi
else
    log "WARN" "未找到安全发现文件，跳过修复步骤"
fi

# 6. 生成最终报告
log "INFO" "步骤6: 生成最终报告..."

# 检查是否有PR创建
PR_FILES=$(find . -name "SECURITY-PR-*.md" -type f | head -1)
if [ -n "$PR_FILES" ]; then
    PR_NUMBER=$(echo "$PR_FILES" | grep -o "[0-9]*")
    log "SUCCESS" "安全PR #$PR_NUMBER 已创建"
fi

# 生成摘要
cat > "$REPORT_DIR/workflow-summary-$AUDIT_DATE.md" << EOF
# 安全审计工作流完成报告 - $AUDIT_DATE

## 执行摘要
- **开始时间**: $(date)
- **工作流状态**: 完成
- **安全发现**: $FINDING_COUNT 个
- **修复分支**: $(if git show-ref --verify --quiet "refs/heads/security-fix-$AUDIT_DATE"; then echo "security-fix-$AUDIT_DATE"; else echo "无"; fi)
- **安全PR**: $(if [ -n "$PR_NUMBER" ]; then echo "#$PR_NUMBER"; else echo "无"; fi)

## 各阶段状态
1. ✅ 代码更新: 完成
2. ✅ 安全审计: 完成 ($FINDING_COUNT 个发现)
3. ✅ 自动修复: $(if [ "$FINDING_COUNT" -gt 0 ]; then echo "执行"; else echo "跳过"; fi)
4. ✅ PR创建: $(if [ -n "$PR_NUMBER" ]; then echo "完成 (#$PR_NUMBER)"; else echo "跳过"; fi)

## 详细报告
- 安全审计报告: security-summary-$AUDIT_DATE.md
- 安全发现: findings-$AUDIT_DATE.json
- 工作流日志: security-workflow-$AUDIT_DATE.log

## 下一步
$(if [ -n "$PR_NUMBER" ]; then
echo "1. 审查安全PR #$PR_NUMBER"
echo "2. 进行安全测试验证"
echo "3. 跟踪PR审查进度"
else
echo "1. 审查安全审计报告"
echo "2. 规划安全改进"
echo "3. 明天继续安全监控"
fi)

---
*报告生成时间: $(date)*  
*执行模式: 手动触发*  
*安全专家: 网络安全专家*
EOF

# 7. 完成
echo ""
echo "================================================"
echo "🛡️  完整安全审计工作流完成"
echo "================================================"
echo "完成时间: $(date)"
echo "安全发现: $FINDING_COUNT 个"
echo "修复分支: $(if git show-ref --verify --quiet "refs/heads/security-fix-$AUDIT_DATE"; then echo "已创建"; else echo "无"; fi)"
echo "安全PR: $(if [ -n "$PR_NUMBER" ]; then echo "#$PR_NUMBER