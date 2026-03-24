#!/bin/bash
set -e

# ===================== 配置项（可根据需求修改）=====================
DEPLOY_PATH="/opt/openclaw"    # 服务器部署根目录
GATEWAY_PORT=18789             # 网关端口
DASHBOARD_PORT=3000            # UI端口
NODE_MIN_VERSION="24.0.0"      # 最低Node版本要求
PM2_PROCESS_NAME="openclaw"    # pm2进程前缀
PM2_CONFIG_FILE="ecosystem.config.js" # 复制到服务器的pm2配置文件名

# ===================== 颜色输出函数（优化提示）=====================
red() { echo -e "\033[31m$1\033[0m"; }
green() { echo -e "\033[32m$1\033[0m"; }
yellow() { echo -e "\033[33m$1\033[0m"; }
blue() { echo -e "\033[34m$1\033[0m"; }

# ===================== 检查Root权限 =====================
if [ $EUID -ne 0 ]; then
  red "❌ 请使用root权限运行脚本（sudo ./deploy.sh）"
  exit 1
fi

# ===================== 检查Node.js版本 =====================
blue "🔍 检查Node.js版本..."
if ! command -v node &> /dev/null; then
  yellow "⚠️ 未安装Node.js，开始安装（Node 24 LTS）..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

NODE_VERSION=$(node -v | sed 's/v//')
# 版本对比函数
version_ge() { test "$(echo "$@" | tr " " "\n" | sort -V | tail -n 1)" = "$1"; }
if ! version_ge ${NODE_VERSION} ${NODE_MIN_VERSION}; then
  red "❌ Node.js版本过低（当前：${NODE_VERSION}，要求≥${NODE_MIN_VERSION}）"
  red "💡 建议手动安装Node 24 LTS：curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs"
  exit 1
fi
green "✅ Node.js版本符合要求：${NODE_VERSION}"

# ===================== 安装pnpm =====================
blue "🔍 检查pnpm..."
if ! command -v pnpm &> /dev/null; then
  yellow "⚠️ 未安装pnpm，开始安装..."
  npm install -g pnpm
fi
green "✅ pnpm已安装：$(pnpm -v)"

# ===================== 安装pm2 =====================
blue "🔍 检查pm2..."
if ! command -v pm2 &> /dev/null; then
  yellow "⚠️ 未安装pm2，开始安装..."
  npm install -g pm2
fi
green "✅ pm2已安装：$(pm2 -v)"

# ===================== 创建部署目录 =====================
blue "📁 准备部署目录..."
mkdir -p ${DEPLOY_PATH}
mkdir -p ${DEPLOY_PATH}/logs
# 备份旧配置（如有）
if [ -f ${DEPLOY_PATH}/openclaw.json ]; then
  cp ${DEPLOY_PATH}/openclaw.json ${DEPLOY_PATH}/openclaw.json.bak.$(date +%Y%m%d%H%M%S)
  yellow "⚠️ 已备份旧配置文件：openclaw.json.bak.$(date +%Y%m%d%H%M%S)"
fi

# ===================== 复制部署文件 =====================
blue "📥 复制部署文件到 ${DEPLOY_PATH}..."
cp -r ./* ${DEPLOY_PATH}/
cd ${DEPLOY_PATH}

# 检查pm2配置文件是否存在
if [ ! -f ${PM2_CONFIG_FILE} ]; then
  red "❌ 服务器部署目录未找到pm2配置文件：${PM2_CONFIG_FILE}"
  exit 1
fi

# ===================== 安装生产依赖 =====================
blue "📦 安装生产依赖..."
pnpm install --production || { red "❌ 依赖安装失败！"; exit 1; }

# ===================== 检查端口占用 =====================
blue "🔌 检查端口占用..."
check_port() {
  if lsof -i:$1 &> /dev/null; then
    yellow "⚠️ 端口 $1 已被占用，尝试杀死占用进程..."
    lsof -ti:$1 | xargs kill -9 || { red "❌ 无法释放端口 $1！"; exit 1; }
  fi
}
check_port ${GATEWAY_PORT}
check_port ${DASHBOARD_PORT}
green "✅ 端口 ${GATEWAY_PORT}/${DASHBOARD_PORT} 已就绪"

# ===================== 启动服务（核心修改：使用复制的pm2配置）=====================
blue "🚀 启动OpenClaw网关和UI..."
# 先停止旧进程（兼容配置文件中的进程名）
pm2 delete ${PM2_PROCESS_NAME}-gateway ${PM2_PROCESS_NAME}-dashboard &> /dev/null || true
# 直接启动本地复制的pm2配置文件
pm2 start ${PM2_CONFIG_FILE}
pm2 save || yellow "⚠️ pm2开机自启配置失败（可手动执行 pm2 startup）"

# ===================== 校验服务状态 =====================
blue "🔍 校验服务状态..."
sleep 5 # 等待服务启动
# 读取pm2配置中的进程名（兼容自定义进程名）
GATEWAY_NAME=$(grep -o '"name": "[^"]*"' ${PM2_CONFIG_FILE} | head -1 | cut -d'"' -f4)
DASHBOARD_NAME=$(grep -o '"name": "[^"]*"' ${PM2_CONFIG_FILE} | tail -1 | cut -d'"' -f4)

if pm2 status ${GATEWAY_NAME} | grep -q "online"; then
  green "✅ 网关服务启动成功！"
else
  red "❌ 网关服务启动失败，日志："
  cat ${DEPLOY_PATH}/logs/gateway-err.log
  exit 1
fi

if pm2 status ${DASHBOARD_NAME} | grep -q "online"; then
  green "✅ UI服务启动成功！"
else
  red "❌ UI服务启动失败，日志："
  cat ${DEPLOY_PATH}/logs/dashboard-err.log
  exit 1
fi

# ===================== 完成提示 =====================
green -e "\n🎉 部署完成！"
blue "🔗 网关地址：http://$(hostname -I | awk '{print $1}'):${GATEWAY_PORT}"
blue "🖥️ UI地址：http://$(hostname -I | awk '{print $1}'):${DASHBOARD_PORT}"
yellow "💡 常用命令："
yellow "  - 查看状态：pm2 status"
yellow "  - 查看日志：pm2 logs ${GATEWAY_NAME} -f"
yellow "  - 重启服务：pm2 restart ${DEPLOY_PATH}/${PM2_CONFIG_FILE}"
