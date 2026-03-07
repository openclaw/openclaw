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
# 探测 pnpm 绝对路径 (systemd 必须使用绝对路径)
pnpm_path=$(command -v pnpm || which pnpm || echo "")
# 探测当前 shell 中的 node
node_path=$(command -v node || which node || echo "")

# 检查当前 node 版本
check_node_v=$($node_path -v 2>/dev/null | grep -oE 'v[0-9]+' | cut -d'v' -f2 || echo "0")

if [ "$check_node_v" -lt 22 ]; then
    echo "⚠️ 检测到系统默认 Node 版本 ($check_node_v) 过低，尝试定位 pnpm 管理的 Node 22..."
    # 尝试查找 pnpm env 默认路径
    pnpm_node="$HOME/.local/share/pnpm/node"
    if [ -f "$pnpm_node" ]; then
        node_path="$pnpm_node"
        echo "✅ 找到 pnpm Node: $node_path"
    else
        echo "❌ 无法找到 Node 22 路径。建议先在终端执行: pnpm env use --global 22"
        exit 1
    fi
fi

echo ">>> 最终选用 Node 路径: $node_path ($($node_path -v))"
echo ">>> pnpm 路径: $pnpm_path"

# 自动同步配置文件
if [ ! -f "$current_dir/openclaw.json" ] && [ -f "$current_dir/deploy/openclaw.json" ]; then
    echo ">>> 同步配置: 将 deploy/openclaw.json 拷贝至根目录..."
    cp "$current_dir/deploy/openclaw.json" "$current_dir/openclaw.json"
fi

# 替换服务文件中的占位符
sed -i "s|/path/to/package|$current_dir|g" "$service_dest"
sed -i "s|你的用户名|$current_user|g" "$service_dest"

# 关键：直接使用绝对路径的 node 启动，绕过可能的版本冲突
# 我们将 ExecStart 替换为：Node绝对路径 脚本绝对路径 gateway
sed -i "s|ExecStart=pnpm exec node dist/index.js gateway|ExecStart=$node_path $current_dir/dist/index.js gateway|g" "$service_dest"

# 如果存在 .env 文件，提示用户确认环境配置
if [ -f "$current_dir/.env" ]; then
    echo ">>> 检测到 .env 文件，已在服务中通过 WorkingDirectory 关联"
fi

echo ">>> 重新加载 Systemd 配置..."
systemctl daemon-reload

echo ">>> 启用并启动 openclaw 服务..."
systemctl enable --now openclaw

echo ""
echo "✅ openclaw 守护进程安装并启动成功！"
echo "您可以通过以下命令查看状态："
echo "systemctl status openclaw"

