#!/bin/bash

# 设置代理
export https_proxy=http://127.0.0.1:7897
export http_proxy=http://127.0.0.1:7897
export all_proxy=socks5://127.0.0.1:7897

echo "🚀 准备推送代码到你的 fork..."
echo ""

# 显示当前分支
echo "📋 当前分支: $(git branch --show-current)"
echo "📦 提交信息: $(git log -1 --oneline)"
echo ""

# 推送
echo "⬆️  推送到 fork/security-message-redaction..."
if git push -u fork security-message-redaction; then
    echo ""
    echo "✅ 推送成功！"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🎉 下一步：创建 Pull Request"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "在浏览器中打开以下链接创建 PR："
    echo ""
    echo "https://github.com/openclaw/openclaw/compare/main...qianjunye:openclaw:security-message-redaction"
    echo ""
    echo "或者访问你的 fork，GitHub 会显示 'Compare & pull request' 按钮："
    echo "https://github.com/qianjunye/openclaw"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
    echo ""
    echo "❌ 推送失败！"
    echo ""
    echo "可能的原因："
    echo "1. 你还没有完成 fork (访问 https://github.com/openclaw/openclaw 点击 Fork)"
    echo "2. SSH 密钥配置有问题 (运行: ssh -T git@github.com)"
    echo "3. 网络连接问题"
    echo ""
fi
