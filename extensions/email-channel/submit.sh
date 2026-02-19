#!/bin/bash
set -e

echo "==============================================="
echo "  Email Channel 提交脚本"
echo "==============================================="
echo ""

# 配置
GITHUB_USER="guxiaobo"
REPO="openclaw"
EMAIL_CHANNEL_DIR="$HOME/Documents/GitHub/openclaw/packages/email-channel"
WORK_DIR="$HOME/temp-openclaw-submit"

echo "📋 配置信息："
echo "  GitHub 用户: $GITHUB_USER"
echo "  仓库名称: $REPO"
echo ""

# 创建工作目录
echo "📁 步骤 1/6: 创建工作目录..."
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
echo "✅ 工作目录创建完成: $WORK_DIR"
echo ""

# 克隆 fork 的仓库（使用 HTTPS）
echo "📥 步骤 2/6: 克隆你的 fork..."
cd "$WORK_DIR"
git clone "https://github.com/$GITHUB_USER/$REPO.git" .
echo "✅ 克隆完成"
echo ""

# 创建 packages 目录并复制 email-channel
echo "📦 步骤 3/6: 添加 Email Channel 包..."
mkdir -p packages
cp -r "$EMAIL_CHANNEL_DIR" packages/
echo "✅ Email Channel 包已复制"
echo ""

# 配置 git
echo "⚙️  步骤 4/6: 配置 Git..."
git config user.name "Gu XiaoBo"
git config user.email "guxiaobo@users.noreply.github.com"
echo "✅ Git 配置完成"
echo ""

# 创建功能分支
echo "🌿 步骤 5/6: 创建功能分支并提交..."
BRANCH_NAME="feature/email-channel-$(date +%Y%m%d)"
git checkout -b "$BRANCH_NAME"

# 添加所有文件
git add .

# 提交
git commit -m "feat: Add official Email channel plugin

Add comprehensive IMAP/SMTP email channel support to Clawdbot:

Features:
- IMAP email receiving with automatic polling
- SMTP email sending for AI responses
- Sender whitelist for security
- Persistent state management with timestamp tracking
- Message-ID deduplication to prevent reprocessing
- Session history integration with Dashboard
- Support for all standard IMAP/SMTP servers

Technical highlights:
- Time-based email search (SINCE) instead of UNSEEN flag
- Processes both read and unread emails correctly
- State persistence survives Gateway restarts
- Automatic cleanup of old Message-IDs
- Session aggregation by sender

Documentation:
- Comprehensive README with configuration examples
- CHANGELOG, CONTRIBUTING, and CONFIG_EXAMPLES guides
- MIT License

See packages/email-channel/README.md for details."

echo "✅ 提交完成"
echo ""

# 推送到 GitHub
echo "🚀 步骤 6/6: 推送到 GitHub..."
git push -u origin "$BRANCH_NAME"
echo "✅ 推送完成"
echo ""

echo "==============================================="
echo "  ✅ 所有步骤完成！"
echo "==============================================="
echo ""

# 显示 PR 创建链接
MAIN_BRANCH=$(git remote show origin | grep "HEAD branch" | sed 's/.*: //' || echo "main")
echo "📊 下一步：创建 Pull Request"
echo ""
echo "1. 在浏览器中打开以下链接："
echo ""
echo "   https://github.com/$GITHUB_USER/$REPO/compare/$MAIN_BRANCH...$BRANCH_NAME"
echo ""
echo "2. PR 标题："
echo "   feat: Add official Email channel plugin"
echo ""
echo "3. PR 描述："
echo "   复制 packages/email-channel/SUBMIT_GUIDE.md 中的模板内容"
echo ""

# 尝试使用 gh CLI 创建 PR（如果可用）
if command -v gh &> /dev/null; then
    echo "或者尝试使用 GitHub CLI 自动创建 PR："
    echo "  gh pr create --title 'feat: Add official Email channel plugin' --file packages/email-channel/SUBMIT_GUIDE.md"
fi
