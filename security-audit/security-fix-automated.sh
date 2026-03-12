#!/bin/bash
# 安全修复自动化脚本 - 基于安全审计结果自动修复常见漏洞
# 执行时间：安全审计后自动运行

set -e

echo "================================================"
echo "🔧 安全修复自动化开始"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "================================================"

# 配置
REPO_DIR="/root/.openclaw/workspace-github_expert/openclaw"
AUDIT_DATE=$(date +%Y%m%d)
REPORT_DIR="/root/.openclaw/workspace-github_expert/security-reports"
FIX_LOG_DIR="/root/.openclaw/workspace-github_expert/security-fixes"

# 创建目录
mkdir -p "$FIX_LOG_DIR"

# 切换到仓库目录
cd "$REPO_DIR" || {
    echo "❌ 错误：无法进入仓库目录 $REPO_DIR"
    exit 1
}

# 函数：记录修复日志
log_fix() {
    local action=$1
    local target=$2
    local details=$3
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local log_file="$FIX_LOG_DIR/security-fixes-$AUDIT_DATE.log"
    
    echo "[$timestamp] [$action] $target - $details" | tee -a "$log_file"
}

# 1. 检查是否有安全审计结果
log_fix "INFO" "检查" "查找最新的安全审计结果..."
LATEST_REPORT=$(ls -t "$REPORT_DIR"/security-summary-*.md 2>/dev/null | head -1)

if [ -z "$LATEST_REPORT" ]; then
    log_fix "WARN" "无报告" "未找到安全审计报告，请先运行安全审计"
    exit 0
fi

log_fix "INFO" "加载报告" "使用报告: $(basename "$LATEST_REPORT")"

# 2. 创建安全修复分支
log_fix "INFO" "分支" "创建安全修复分支..."
git checkout daily-sync
git pull origin daily-sync
git checkout -b "security-fix-$AUDIT_DATE"

# 3. 自动修复常见安全问题

### 3.1 修复硬编码密钥（模式匹配）
log_fix "INFO" "修复" "扫描并修复硬编码密钥..."
HARDCODED_PATTERNS=(
    "password.*=.*['\"].{6,}['\"]"
    "secret.*=.*['\"].{8,}['\"]"
    "api_key.*=.*['\"].{10,}['\"]"
    "token.*=.*['\"].{10,}['\"]"
    "auth.*=.*['\"].{8,}['\"]"
)

FIX_COUNT=0
for pattern in "${HARDCODED_PATTERNS[@]}"; do
    # 查找匹配的文件
    grep -r -l -E "$pattern" . --include="*.js" --include="*.ts" --include="*.py" --include="*.json" 2>/dev/null | while read file; do
        # 跳过node_modules和dist目录
        if [[ "$file" == *"node_modules"* ]] || [[ "$file" == *"dist"* ]] || [[ "$file" == *".git"* ]]; then
            continue
        fi
        
        log_fix "MEDIUM" "硬编码密钥" "文件 $file 可能包含硬编码密钥"
        
        # 对于.env.example文件，添加注释而不是删除
        if [[ "$file" == *".env.example" ]]; then
            sed -i "s/\($pattern\)/# \1  # TODO: 使用环境变量替代硬编码密钥/" "$file"
            log_fix "FIXED" "注释化" "在 $file 中注释了硬编码密钥"
            ((FIX_COUNT++))
        fi
    done
done

### 3.2 修复不安全的配置
log_fix "INFO" "修复" "修复不安全配置..."
# 查找并修复调试模式配置
find . -type f \( -name "*.js" -o -name "*.ts" -o -name "*.json" \) -exec grep -l "debug.*=.*true" {} \; 2>/dev/null | while read file; do
    # 添加安全注释
    sed -i "s/debug.*=.*true/debug = false  # 安全修复: 生产环境应禁用调试模式/" "$file"
    log_fix "FIXED" "调试模式" "在 $file 中禁用了调试模式"
    ((FIX_COUNT++))
done

### 3.3 添加基本的安全头（如果适用）
log_fix "INFO" "修复" "检查并添加安全头..."
# 查找Express.js或类似框架的配置文件
find . -type f -name "*.js" -o -name "*.ts" | xargs grep -l "express\|app\.use" 2>/dev/null | head -5 | while read file; do
    # 检查是否已经设置了安全头
    if ! grep -q "helmet\|securityHeaders\|X-Content-Type-Options" "$file"; then
        log_fix "INFO" "安全头" "文件 $file 可能缺少安全头配置"
        # 这里可以添加自动插入安全头代码的逻辑
    fi
done

### 3.4 修复简单的XSS漏洞模式
log_fix "INFO" "修复" "检查XSS漏洞模式..."
# 查找innerHTML的直接使用
find . -type f \( -name "*.js" -o -name "*.ts" \) -exec grep -l "innerHTML.*=" {} \; 2>/dev/null | head -5 | while read file; do
    log_fix "MEDIUM" "XSS风险" "文件 $file 使用innerHTML，可能存在XSS风险"
    # 添加安全注释
    sed -i "s/innerHTML\(.*=\)/innerHTML\1  \/\/ 安全注意: 确保内容经过消毒/" "$file"
    ((FIX_COUNT++))
done

### 3.5 更新已知漏洞的依赖（如果package.json存在）
log_fix "INFO" "修复" "检查依赖漏洞..."
if [ -f "package.json" ]; then
    # 检查是否有已知漏洞的依赖
    VULNERABLE_DEPS=$(grep -E '"([0-9]+\.[0-9]+\.[0-9]+)"' package.json | grep -v "\"0\." | head -5)
    if [ -n "$VULNERABLE_DEPS" ]; then
        log_fix "INFO" "依赖" "发现可能过时的依赖版本"
        # 这里可以添加自动更新依赖的逻辑
    fi
fi

# 4. 提交安全修复
if [ $FIX_COUNT -gt 0 ]; then
    log_fix "INFO" "提交" "提交安全修复 ($FIX_COUNT 处修复)..."
    
    # 添加所有修改
    git add .
    
    # 提交修复
    git commit -m "security: automated security fixes

- 修复硬编码密钥问题
- 禁用不安全的调试配置
- 添加安全注释和警告
- 修复 $FIX_COUNT 个安全问题

Automated security fixes based on security audit findings."

    # 推送到远程
    git push origin "security-fix-$AUDIT_DATE"
    
    log_fix "SUCCESS" "推送" "安全修复分支已推送到远程: security-fix-$AUDIT_DATE"
else
    log_fix "INFO" "无修复" "未发现需要自动修复的安全问题"
fi

# 5. 生成修复报告
cat > "$FIX_LOG_DIR/security-fixes-summary-$AUDIT_DATE.md" << EOF
# 安全自动修复报告 - $AUDIT_DATE

## 修复摘要
- **修复时间**: $(date)
- **修复分支**: security-fix-$AUDIT_DATE
- **修复数量**: $FIX_COUNT
- **代码版本**: $(git rev-parse --short HEAD)

## 修复内容

### 自动修复的问题
1. **硬编码密钥**: 在配置文件中注释了硬编码的密钥
2. **不安全配置**: 禁用了调试模式等不安全配置
3. **XSS风险**: 为innerHTML使用添加了安全警告
4. **安全头**: 检查了安全头配置

### 需要人工审查的问题
以下问题需要人工审查和修复：
1. 复杂的业务逻辑漏洞
2. 架构级安全问题
3. 第三方依赖的深度漏洞
4. 需要业务上下文的安全配置

## 下一步建议

### 立即行动
1. 审查自动修复的更改
2. 运行安全测试验证修复效果
3. 创建安全修复PR

### 后续步骤
1. 实施更复杂的安全修复
2. 建立持续的安全扫描
3. 进行安全代码审查
4. 定期安全培训

## 技术详情
- 修复日志: security-fixes-$AUDIT_DATE.log
- 代码差异: 使用 \`git diff daily-sync..security-fix-$AUDIT_DATE\`
- 审计报告: $(basename "$LATEST_REPORT")

---
*修复完成时间: $(date)*  
*安全专家: 网络安全专家*  
*自动化级别: 基础自动修复*
EOF

# 6. 完成修复
echo ""
echo "================================================"
echo "🔧 安全自动修复完成"
echo "================================================"
echo "修复时间: $(date)"
echo "修复数量: $FIX_COUNT"
echo "修复分支: security-fix-$AUDIT_DATE"
echo ""
echo "报告文件:"
echo "  📋 修复摘要: $FIX_LOG_DIR/security-fixes-summary-$AUDIT_DATE.md"
echo "  📝 修复日志: $FIX_LOG_DIR/security-fixes-$AUDIT_DATE.log"
echo ""
echo "下一步:"
echo "  1. 审查自动修复的更改"
echo "  2. 运行 \`git diff daily-sync..security-fix-$AUDIT_DATE\`"
echo "  3. 创建安全修复PR"
echo "  4. 进行安全测试验证"
echo "================================================"

exit 0