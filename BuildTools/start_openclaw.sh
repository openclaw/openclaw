#!/bin/bash
# OpenClaw 模式一：基础后台服务运行脚本
# 该脚本按照约定的规则存放在 BuildTools 目录下

# 获取脚本所在的目录，并计算出项目根目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=================================================="
echo "      启动 OpenClaw 基础后台服务 (Gateway)"
echo "项目主目录: $PROJECT_ROOT"
echo "=================================================="

# 切换到项目根目录
cd "$PROJECT_ROOT" || { echo "无法进入项目根目录"; exit 1; }

# 检查 pnpm 是否安装，如果没有安装，给出提示
if ! command -v pnpm &> /dev/null; then
    echo "未找到 pnpm，请确保 Node.js 和 pnpm 已经正确安装并在环境变量中。"
    echo "可执行 'npm install -g pnpm' 进行安装。"
    exit 1
fi

echo "正在启动基础后台服务..."
pnpm start gateway --allow-unconfigured
