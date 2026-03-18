#!/bin/bash
# Bailian MaxPerf - 百炼满血优化脚本
# 全方位优化阿里百炼在 OpenClaw 中的性能

set -e

OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
OPENCLAW_DIST="$HOME/.npm-global/lib/node_modules/openclaw/dist"

echo "🚀 百炼满血优化脚本 (Bailian MaxPerf)"
echo "======================================"
echo ""

# ==================== 步骤 1: Token Usage 修复 ====================
echo "📊 步骤 1: Token Usage 兼容修复"
echo "--------------------------------"

if grep -q '"supportsUsageInStreaming"' "$OPENCLAW_CONFIG" 2>/dev/null; then
    echo "✅ Token Usage 配置已存在，跳过"
else
    echo "⚙️  添加 compat 配置..."
    python3 -c "
import json
with open('$OPENCLAW_CONFIG', 'r') as f:
    config = json.load(f)
if 'bailian' in config.get('models', {}).get('providers', {}):
    for model in config['models']['providers']['bailian']['models']:
        model['compat'] = {'supportsUsageInStreaming': True}
    with open('$OPENCLAW_CONFIG', 'w') as f:
        json.dump(config, f, indent=2)
    print('✅ 已添加 supportsUsageInStreaming: true')
else:
    print('⚠️  未找到 bailian provider')
"
fi

# 修复运行时文件
FILES=(
    "auth-profiles-DDVivXkv.js"
    "auth-profiles-DRjqKE3G.js"
    "model-selection-46xMp11W.js"
    "model-selection-CU2b7bN6.js"
    "discord-CcCLMjHw.js"
)

for file in "${FILES[@]}"; do
    filepath="$OPENCLAW_DIST/$file"
    if [ -f "$filepath" ] && ! grep -q "prompt_tokens ?? 0" "$filepath"; then
        sed -i 's/response\.usage?\.input_tokens ?? 0/response.usage?.input_tokens ?? response.usage?.prompt_tokens ?? 0/g' "$filepath"
        sed -i 's/response\.usage?\.output_tokens ?? 0/response.usage?.output_tokens ?? response.usage?.completion_tokens ?? 0/g' "$filepath"
        echo "✅ 修复 $file"
    fi
done

echo ""

# ==================== 步骤 2: 模型窗口优化 ====================
echo "📏 步骤 2: 模型窗口大小优化"
echo "--------------------------"

python3 -c "
import json

# 阿里百炼官方模型窗口配置 (2026 年最新)
OFFICIAL_CONFIG = {
    'qwen3.5-plus': {'contextWindow': 262144, 'maxTokens': 65536},
    'qwen3-max-2026-01-23': {'contextWindow': 262144, 'maxTokens': 65536},
    'qwen3-coder-next': {'contextWindow': 262144, 'maxTokens': 65536},
    'qwen3-coder-plus': {'contextWindow': 262144, 'maxTokens': 65536},
    'MiniMax-M2.5': {'contextWindow': 204800, 'maxTokens': 131072},
    'glm-5': {'contextWindow': 202752, 'maxTokens': 16384},
    'glm-4.7': {'contextWindow': 202752, 'maxTokens': 16384},
    'kimi-k2.5': {'contextWindow': 262144, 'maxTokens': 32768},
}

with open('$OPENCLAW_CONFIG', 'r') as f:
    config = json.load(f)

updated = False
if 'bailian' in config.get('models', {}).get('providers', {}):
    for model in config['models']['providers']['bailian']['models']:
        model_id = model.get('id', '')
        if model_id in OFFICIAL_CONFIG:
            official = OFFICIAL_CONFIG[model_id]
            if model.get('contextWindow') != official['contextWindow']:
                print(f\"⚙️  {model_id}: contextWindow {model.get('contextWindow')} → {official['contextWindow']}\")
                model['contextWindow'] = official['contextWindow']
                updated = True
            if model.get('maxTokens') != official['maxTokens']:
                print(f\"⚙️  {model_id}: maxTokens {model.get('maxTokens')} → {official['maxTokens']}\")
                model['maxTokens'] = official['maxTokens']
                updated = True

if updated:
    with open('$OPENCLAW_CONFIG', 'w') as f:
        json.dump(config, f, indent=2)
    print('✅ 模型窗口配置已更新')
else:
    print('✅ 模型窗口配置已是最新')
"

echo ""

# ==================== 步骤 3: 配置验证 ====================
echo "🔍 步骤 3: 配置验证"
echo "------------------"

if command -v openclaw &> /dev/null; then
    if openclaw status &> /dev/null; then
        echo "✅ 配置校验通过"
    else
        echo "❌ 配置校验失败"
        exit 1
    fi
else
    echo "⚠️  openclaw 命令不可用，跳过验证"
fi

echo ""
echo "======================================"
echo "✅ 百炼满血优化完成！"
echo ""
echo "📊 优化项目:"
echo "   ✅ Token Usage 兼容修复"
echo "   ✅ 模型窗口大小优化 (官方最新值)"
echo ""
echo "🔄 下一步：重启 Gateway"
echo "   openclaw gateway restart"
echo ""
echo "📈 验证方法:"
echo "   1. /chat 使用 qwen3.5-plus 生成长文本"
echo "   2. /status 查看 token 统计和 context 窗口"
echo "   3. 应显示精确的 usage 和窗口大小"
echo ""
echo "⚠️  注意：npm install -g openclaw@... 后需重新执行"
echo ""
