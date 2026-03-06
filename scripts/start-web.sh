#!/usr/bin/env bash
set -euo pipefail

echo "🚀 启动 OpenGen Next.js 控制台..."
echo "ℹ️ 默认地址: http://127.0.0.1:3301"
echo ""

if [ -z "${LLM_BASE_URL:-}" ] || [ -z "${LLM_API_KEY:-}" ]; then
  echo "⚠️  检测到 LLM_BASE_URL 或 LLM_API_KEY 未设置。"
  echo "   /api/generate 在未配置模型时将返回错误。"
fi

pnpm opengen:dev -- --hostname 127.0.0.1 --port "${PORT:-3301}"
