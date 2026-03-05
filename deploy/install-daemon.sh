#!/usr/bin/env bash

set -e

# 获取脚本所在目录的上一级目录作为实际解压工作目录
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
current_dir=$(dirname "$script_dir")
# 获取当前执行此脚本的用户名（如果有 sudo 执行的情况，获取真实用户）
current_user=${SUDO_USER:-$(whoami)}

echo ">>> 正在配置 OpenClaw Gateway Systemd 守护单元..."

# 检查权限
if [ "$EUID" -ne 0 ]; then
  echo "请使用 sudo 权限执行此脚本 (例如: sudo ./deploy/install-daemon.sh)"
  exit 1
fi

service_src="$script_dir/openclaw.service"
service_dest="/etc/systemd/system/openclaw.service"

if [ ! -f "$service_src" ]; then
    echo "❌ 找不到 $service_src，请确保您在主解压目录执行此脚本"
    exit 1
fi

echo ">>> 安装服务文件到 $service_dest"
cp "$service_src" "$service_dest"

echo ">>> 使用当前环境配置更新服务文件..."
# 替换服务文件中的占位符
sed -i "s|/path/to/package|$current_dir|g" "$service_dest"
sed -i "s|你的用户名|$current_user|g" "$service_dest"

echo ">>> 重新加载 Systemd 配置..."
systemctl daemon-reload

echo ">>> 启用并启动 openclaw 服务..."
systemctl enable --now openclaw

echo ""
echo "✅ openclaw 守护进程安装并启动成功！"
echo "您可以通过以下命令查看状态："
echo "systemctl status openclaw"
