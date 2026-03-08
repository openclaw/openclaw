#!/bin/bash
# 安全审计主脚本 - 网络安全专家每日安全审计
# 执行时间：北京时间21:00 (13:00 UTC)

set -e

echo "================================================"
echo "🔒 网络安全专家 - 每日安全审计开始"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "项目: openclaw/openclaw"
echo "================================================"

# 配置
REPO_DIR="/root/.openclaw/workspace-github_expert/openclaw"
AUDIT_DATE=$(date +%Y%m%d)
LOG_DIR="/root/.openclaw/workspace-github_expert/security-audit-logs"
REPORT_DIR="/root/.openclaw/workspace-github_expert/security-reports"
SECURITY_TOOLS_DIR="/root/.openclaw/workspace-github_expert/openclaw/security-audit/tools"

# 创建目录
mkdir -p "$LOG_DIR" "$REPORT_DIR" "$SECURITY_TOOLS_DIR"

# 切换到仓库目录
cd "$REPO_DIR" || {
    echo "❌ 错误：无法进入仓库目录 $REPO_DIR"
    exit 1
}

# 函数：记录审计日志
log_audit() {
    local level=$1
    local message=$2
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local log_file="$LOG_DIR/security-audit-$AUDIT_DATE.log"
    
    echo "[$timestamp] [$level] $message" | tee -a "$log_file"
}

# 函数：记录安全发现
log_finding() {
    local severity=$1
    local category=$2
    local title=$3
    local description=$4
    local recommendation=$5
    
    local finding_file="$REPORT_DIR/findings-$AUDIT_DATE.json"
    
    # 如果是第一次发现，初始化JSON数组
    if [ ! -f "$finding_file" ]; then
        echo "[" > "$finding_file"
    else
        # 移除最后的 ] 并添加逗号
        sed -i '$ d' "$finding_file"
        echo "  }," >> "$finding_file"
    fi
    
    # 添加新发现
    cat >> "$finding_file" << EOF
  {
    "id": "FINDING-$(date +%Y%m%d-%H%M%S)",
    "severity": "$severity",
    "category": "$category",
    "title": "$title",
    "description": "$description",
    "recommendation": "$recommendation",
    "timestamp": "$(date -Iseconds)",
    "status": "open"
EOF
    echo "  }" >> "$finding_file"
    echo "]" >> "$finding_file"
}

# 函数：检查命令执行结果
check_tool_result() {
    local tool_name=$1
    local exit_code=$2
    
    if [ $exit_code -eq 0 ]; then
        log_audit "INFO" "✅ $tool_name 检查完成"
    else
        log_audit "WARN" "⚠️  $tool_name 检查异常 (退出码: $exit_code)"
    fi
}

# 1. 更新代码到最新
log_audit "INFO" "步骤1: 更新代码到最新版本..."
git checkout daily-sync
git pull origin daily-sync

# 2. 安装安全工具（如果未安装）
log_audit "INFO" "步骤2: 检查安全工具..."
install_security_tools() {
    # 检查并安装Bandit (Python安全扫描)
    if ! command -v bandit &> /dev/null; then
        log_audit "INFO" "安装Bandit安全扫描工具..."
        pip3 install bandit 2>/dev/null || log_audit "WARN" "Bandit安装失败"
    fi
    
    # 检查并安装Safety (Python依赖安全检查)
    if ! command -v safety &> /dev/null; then
        log_audit "INFO" "安装Safety依赖检查工具..."
        pip3 install safety 2>/dev/null || log_audit "WARN" "Safety安装失败"
    fi
    
    # 检查并安装TruffleHog (密钥检测)
    if ! command -v trufflehog &> /dev/null; then
        log_audit "INFO" "安装TruffleHog密钥检测工具..."
        pip3 install trufflehog 2>/dev/null || log_audit "WARN" "TruffleHog安装失败"
    fi
}
install_security_tools

# 3. 开始安全审计
log_audit "INFO" "步骤3: 开始全面安全审计..."

# 3.1 依赖安全检查
log_audit "INFO" "3.1 依赖安全检查..."
if command -v safety &> /dev/null; then
    safety check --json 2>/dev/null > "$REPORT_DIR/dependencies-$AUDIT_DATE.json" || true
    DEPENDENCY_ISSUES=$(jq '.vulnerabilities | length' "$REPORT_DIR/dependencies-$AUDIT_DATE.json" 2>/dev/null || echo "0")
    if [ "$DEPENDENCY_ISSUES" -gt 0 ]; then
        log_audit "HIGH" "发现 $DEPENDENCY_ISSUES 个依赖漏洞"
        log_finding "high" "dependencies" "第三方依赖漏洞" "发现 $DEPENDENCY_ISSUES 个有漏洞的依赖包" "更新有漏洞的依赖到安全版本"
    fi
fi

# 3.2 Python代码安全扫描
log_audit "INFO" "3.2 Python代码安全扫描..."
if command -v bandit &> /dev/null; then
    find . -name "*.py" -type f | head -20 | while read py_file; do
        bandit -r "$py_file" -f json 2>/dev/null > "$REPORT_DIR/bandit-$(basename "$py_file")-$AUDIT_DATE.json" || true
        PY_ISSUES=$(jq '.metrics._totals.issues' "$REPORT_DIR/bandit-$(basename "$py_file")-$AUDIT_DATE.json" 2>/dev/null || echo "0")
        if [ "$PY_ISSUES" -gt 0 ]; then
            log_audit "MEDIUM" "Python文件 $py_file 发现 $PY_ISSUES 个安全问题"
        fi
    done
fi

# 3.3 密钥和敏感信息检测
log_audit "INFO" "3.3 密钥和敏感信息检测..."
if command -v trufflehog &> /dev/null; then
    trufflehog filesystem --directory=. --json 2>/dev/null > "$REPORT_DIR/secrets-$AUDIT_DATE.json" || true
    SECRET_COUNT=$(jq '. | length' "$REPORT_DIR/secrets-$AUDIT_DATE.json" 2>/dev/null || echo "0")
    if [ "$SECRET_COUNT" -gt 0 ]; then
        log_audit "CRITICAL" "发现 $SECRET_COUNT 个可能的密钥泄露"
        log_finding "critical" "secrets" "密钥泄露风险" "发现 $SECRET_COUNT 个可能的敏感信息泄露" "立即轮换相关密钥，移除代码中的硬编码密钥"
    fi
fi

# 3.4 配置文件安全检查
log_audit "INFO" "3.4 配置文件安全检查..."
CONFIG_FILES=(".env.example" "docker-compose.yml" "Dockerfile*" "*.config.*" "*.conf" "package.json")
for config_pattern in "${CONFIG_FILES[@]}"; do
    find . -name "$config_pattern" -type f | head -10 | while read config_file; do
        # 检查硬编码密钥
        if grep -q -E "(password|secret|key|token|auth).*=.*['\"].{8,}['\"]" "$config_file" 2>/dev/null; then
            log_audit "HIGH" "配置文件 $config_file 可能包含硬编码密钥"
            log_finding "high" "configuration" "硬编码密钥" "配置文件 $config_file 中可能包含硬编码的密钥" "使用环境变量或密钥管理服务替代硬编码密钥"
        fi
        
        # 检查不安全配置
        if grep -q -E "(debug.*=.*true|insecure.*=.*true|ssl.*=.*false)" "$config_file" 2>/dev/null; then
            log_audit "MEDIUM" "配置文件 $config_file 包含不安全配置"
            log_finding "medium" "configuration" "不安全配置" "配置文件 $config_file 中包含可能不安全的配置项" "在生产环境中禁用调试模式，启用安全配置"
        fi
    done
done

# 3.5 权限和访问控制检查
log_audit "INFO" "3.5 权限和访问控制检查..."
# 检查文件权限
find . -type f -name "*.sh" -o -name "*.py" | head -20 | while read script_file; do
    if [ -x "$script_file" ]; then
        # 检查是否有setuid/setgid位
        if ls -l "$script_file" | grep -q -E "^...s......|^......s..."; then
            log_audit "HIGH" "脚本文件 $script_file 设置了setuid/setgid位"
            log_finding "high" "permissions" "危险的文件权限" "脚本文件 $script_file 设置了setuid/setgid位，可能存在权限提升风险" "审查脚本必要性，移除不必要的setuid/setgid位"
        fi
    fi
done

# 3.6 输入验证检查
log_audit "INFO" "3.6 输入验证检查..."
# 查找可能的用户输入处理代码
INPUT_PATTERNS=("req\\.body" "req\\.query" "req\\.params" "JSON\\.parse" "eval(" "Function(" "exec(" "system(")
for pattern in "${INPUT_PATTERNS[@]}"; do
    find . -type f \( -name "*.js" -o -name "*.ts" -o -name "*.py" \) -exec grep -l "$pattern" {} \; 2>/dev/null | head -10 | while read code_file; do
        log_audit "INFO" "文件 $code_file 包含用户输入处理: $pattern"
        # 检查是否有输入验证
        if ! grep -q -E "(validate|sanitize|escape|filter)" "$code_file" 2>/dev/null; then
            log_audit "MEDIUM" "文件 $code_file 可能缺少输入验证"
            log_finding "medium" "input_validation" "缺少输入验证" "文件 $code_file 处理用户输入但可能缺少适当的验证" "添加输入验证和输出编码，防止注入攻击"
        fi
    done
done

# 4. 生成审计报告
log_audit "INFO" "步骤4: 生成安全审计报告..."

# 统计发现
TOTAL_FINDINGS=$(jq '. | length' "$REPORT_DIR/findings-$AUDIT_DATE.json" 2>/dev/null || echo "0")
CRITICAL_COUNT=$(jq '[.[] | select(.severity == "critical")] | length' "$REPORT_DIR/findings-$AUDIT_DATE.json" 2>/dev/null || echo "0")
HIGH_COUNT=$(jq '[.[] | select(.severity == "high")] | length' "$REPORT_DIR/findings-$AUDIT_DATE.json" 2>/dev/null || echo "0")
MEDIUM_COUNT=$(jq '[.[] | select(.severity == "medium")] | length' "$REPORT_DIR/findings-$AUDIT_DATE.json" 2>/dev/null || echo "0")

# 生成摘要报告
cat > "$REPORT_DIR/security-summary-$AUDIT_DATE.md" << EOF
# 安全审计报告 - $AUDIT_DATE

## 执行摘要
- **审计时间**: $(date)
- **审计目标**: openclaw/openclaw
- **代码版本**: $(git rev-parse --short HEAD)
- **总发现数**: $TOTAL_FINDINGS

## 风险统计
- 🔴 **严重风险**: $CRITICAL_COUNT
- 🟠 **高风险**: $HIGH_COUNT  
- 🟡 **中风险**: $MEDIUM_COUNT
- 🟢 **低风险**: $((TOTAL_FINDINGS - CRITICAL_COUNT - HIGH_COUNT - MEDIUM_COUNT))

## 关键发现

EOF

# 添加关键发现
if [ "$CRITICAL_COUNT" -gt 0 ]; then
    echo "### 🔴 严重风险" >> "$REPORT_DIR/security-summary-$AUDIT_DATE.md"
    jq -r '.[] | select(.severity == "critical") | "- **\(.title)**: \(.description)"' "$REPORT_DIR/findings-$AUDIT_DATE.json" 2>/dev/null >> "$REPORT_DIR/security-summary-$AUDIT_DATE.md" || true
fi

if [ "$HIGH_COUNT" -gt 0 ]; then
    echo "" >> "$REPORT_DIR/security-summary-$AUDIT_DATE.md"
    echo "### 🟠 高风险" >> "$REPORT_DIR/security-summary-$AUDIT_DATE.md"
    jq -r '.[] | select(.severity == "high") | "- **\(.title)**: \(.description)"' "$REPORT_DIR/findings-$AUDIT_DATE.json" 2>/dev/null >> "$REPORT_DIR/security-summary-$AUDIT_DATE.md" || true
fi

# 添加建议
cat >> "$REPORT_DIR/security-summary-$AUDIT_DATE.md" << EOF

## 修复建议

### 立即行动（1-3天）
1. 修复所有严重和高风险漏洞
2. 轮换泄露的密钥
3. 更新有漏洞的依赖

### 短期改进（1-2周）
1. 实施输入验证和输出编码
2. 修复中风险配置问题
3. 建立持续的安全扫描

### 长期规划（1-3月）
1. 实施安全开发生命周期
2. 建立安全监控和响应
3. 定期安全培训和意识提升

## 详细报告
- 完整发现列表: findings-$AUDIT_DATE.json
- 依赖检查: dependencies-$AUDIT_DATE.json
- 密钥检测: secrets-$AUDIT_DATE.json
- 审计日志: security-audit-$AUDIT_DATE.log

## 下一步
1. 审查所有发现
2. 制定修复计划
3. 实施安全修复
4. 验证修复效果

---
*报告生成时间: $(date)*  
*审计专家: 网络安全专家*  
*联系方式: 通过GitHub专家渠道*
EOF

# 5. 完成审计
log_audit "INFO" "步骤5: 安全审计完成"
echo ""
echo "================================================"
echo "🔒 安全审计完成摘要"
echo "================================================"
echo "审计时间: $(date)"
echo "代码版本: $(git rev-parse --short HEAD)"
echo "总发现数: $TOTAL_FINDINGS"
echo "严重风险: $CRITICAL_COUNT"
echo "高风险: $HIGH_COUNT"
echo "中风险: $MEDIUM_COUNT"
echo ""
echo "报告文件:"
echo "  📋 摘要报告: $REPORT_DIR/security-summary-$AUDIT_DATE.md"
echo "  📊 详细发现: $REPORT_DIR/findings-$AUDIT_DATE.json"
echo "  📝 审计日志: $LOG_DIR/security-audit-$AUDIT_DATE.log"
echo ""
echo "下一步:"
echo "  1. 审查安全发现"
echo "  2. 制定修复优先级"
echo "  3. 实施安全修复"
echo "  4. 提交安全PR"
echo "================================================"

exit 0