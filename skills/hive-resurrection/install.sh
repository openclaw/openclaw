#!/bin/bash
set -e

NODE_NAME="${1:?用法：./install.sh <节点名> 例如：./install.sh node-a}"
INSTALL_DIR="/opt/hive-resurrection"

# 检测操作系统
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    USER="$(whoami)"
    LAUNCHD_DIR="$HOME/Library/LaunchAgents"
    USE_LAUNCHD=true
else
    # Linux
    USER="deploy"
    USE_LAUNCHD=false
fi

echo "=========================================="
echo "  蜂巢复活系统安装脚本"
echo "  节点名：${NODE_NAME}"
echo "=========================================="

echo "[1/7] 检查依赖..."

if ! command -v node &> /dev/null; then
    echo "错误：需要 Node.js >= 18"
    echo "安装：curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "错误：Node.js 版本太低 (当前：$(node -v), 需要：>= 18)"
    exit 1
fi

echo "  Node.js: $(node -v) [OK]"

echo "[2/7] 检查用户..."

if ! id "$USER" &>/dev/null; then
    echo "  创建用户 ${USER}..."
    sudo useradd -m -s /bin/bash "$USER"
fi
echo "  用户 ${USER} [OK]"

echo "[3/7] 安装文件..."

sudo mkdir -p "$INSTALL_DIR"
sudo cp watchdog.js monitor.js doctor.js hive-watchdog.service hive-monitor.service "$INSTALL_DIR/"
sudo cp config.example.json "$INSTALL_DIR/config.json"
sudo chown -R "$USER:$USER" "$INSTALL_DIR"
echo "  文件已复制到 ${INSTALL_DIR} [OK]"

echo "[4/7] 创建数据目录..."

sudo -u "$USER" mkdir -p "/home/${USER}/.hive/logs"
echo "  数据目录 [OK]"

if [ "$USE_LAUNCHD" = true ]; then
    echo "[5/7] 安装 launchd 服务..."
    
    mkdir -p "$LAUNCHD_DIR"
    cp "$INSTALL_DIR/hive-watchdog.plist" "$LAUNCHD_DIR/"
    cp "$INSTALL_DIR/hive-monitor.plist" "$LAUNCHD_DIR/"
    
    # 替换节点名
    sed -i.bak "s/node-a/${NODE_NAME}/g" "$LAUNCHD_DIR/hive-watchdog.plist"
    sed -i.bak "s/node-a/${NODE_NAME}/g" "$LAUNCHD_DIR/hive-monitor.plist"
    
    # 加载服务
    launchctl load "$LAUNCHD_DIR/hive-watchdog.plist"
    launchctl load "$LAUNCHD_DIR/hive-monitor.plist"
    
    echo "  launchd 服务 [OK]"
    
    echo "[6/7] 配置节点名..."
    echo "  节点名：${NODE_NAME} [OK]"
    
    echo "[7/7] 启动服务..."
    launchctl start hive-watchdog
    launchctl start hive-monitor
    echo "  服务已启动 [OK]"
else
    echo "[5/7] 安装 systemd 服务..."
    
    sudo cp "$INSTALL_DIR/hive-watchdog.service" /etc/systemd/system/
    sudo cp "$INSTALL_DIR/hive-monitor.service" /etc/systemd/system/
    sudo systemctl daemon-reload
    echo "  systemd 服务 [OK]"
    
    echo "[6/7] 配置节点名..."
    
    sudo sed -i "s/node-a/${NODE_NAME}/g" /etc/systemd/system/hive-watchdog.service
    sudo sed -i "s/node-a/${NODE_NAME}/g" /etc/systemd/system/hive-monitor.service
    sudo systemctl daemon-reload
    echo "  节点名配置：${NODE_NAME} [OK]"
    
    echo "[7/7] 启动服务..."
    
    sudo systemctl enable hive-watchdog
    sudo systemctl enable hive-monitor
    sudo systemctl start hive-watchdog
    sudo systemctl start hive-monitor
    echo "  服务已启动 [OK]"
fi

echo ""
echo "=========================================="
echo "  安装完成！"
echo "=========================================="
echo ""
echo "服务状态:"
echo "  systemctl status hive-watchdog"
echo "  systemctl status hive-monitor"
echo ""
echo "日志查看:"
echo "  journalctl -u hive-watchdog -f"
echo "  journalctl -u hive-monitor -f"
echo ""
echo "重要：请修改 config.json 中的："
echo "  1. 各节点的 host IP 地址"
echo "  2. secret 密钥 (所有节点必须相同)"
echo "  3. openclaw 的 workDir 路径"
echo ""
echo "修改后重启服务:"
echo "  sudo systemctl restart hive-watchdog hive-monitor"
echo ""
