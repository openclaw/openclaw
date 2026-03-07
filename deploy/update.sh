#!/usr/bin/env bash

set -e

usage() {
  echo "用法: $0 <安装目录> <压缩包路径>"
  echo ""
  echo "参数:"
  echo "  安装目录      OpenClaw 已部署的目录 (如 /opt/openclaw)"
  echo "  压缩包路径    pnpm pack 生成的 .tgz 文件路径"
  echo ""
  echo "示例:"
  echo "  $0 /opt/openclaw /tmp/openclaw-2026.3.3.tgz"
  echo ""
  echo "注意: 此脚本会保留 agents/, workspace/, openclaw.json, .env 等用户数据"
  exit 1
}

# 检查参数
if [ $# -ne 2 ]; then
  echo "错误: 需要两个参数"
  usage
fi

PKG_DIR="$1"
TGZ_PATH="$2"

# 验证参数
if [ ! -d "$PKG_DIR" ]; then
  echo "错误: 安装目录不存在: $PKG_DIR"
  exit 1
fi

if [ ! -f "$TGZ_PATH" ]; then
  echo "错误: 压缩包不存在: $TGZ_PATH"
  exit 1
fi

if [[ ! "$TGZ_PATH" == *.tgz ]]; then
  echo "错误: 压缩包必须是 .tgz 格式: $TGZ_PATH"
  exit 1
fi

echo ">>> 安装目录: $PKG_DIR"
echo ">>> 压缩包: $TGZ_PATH"

# 检查关键目录是否存在
if [ ! -d "$PKG_DIR/agents" ]; then
  echo "警告: $PKG_DIR/agents 目录不存在，这可能是一个全新安装"
fi

echo ">>> 停止服务..."
sudo systemctl stop openclaw 2>/dev/null || echo "提示: 服务未安装或未运行，继续更新..."

echo ">>> 解压新版本..."
cd "$PKG_DIR"

# 解压，排除用户数据目录和配置文件
tar -xzf "$TGZ_PATH" --strip-components=1 --overwrite \
  --exclude='agents' \
  --exclude='workspace' \
  --exclude='openclaw.json' \
  --exclude='.env'

echo ">>> 重启服务..."
sudo systemctl restart openclaw 2>/dev/null || echo "提示: 请手动启动服务"

echo ">>> 完成!"
sudo systemctl status openclaw 2>/dev/null || true

echo ""
echo "已保留的用户数据:"
echo "  - agents/         (会话记录)"
echo "  - workspace/      (用户自定义文件: AGENTS.md, SOUL.md, TOOLS.md, skills/)"
echo "  - openclaw.json   (服务配置)"
echo "  - .env            (环境变量)"
