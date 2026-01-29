#!/bin/bash
# Moltbot 企业部署脚本
# 适用于 Ubuntu/Debian Linux

set -e

# ===== 配置变量 =====
MOLTBOT_USER="moltbot"
MOLTBOT_HOME="/var/lib/moltbot"
MOLTBOT_LOG_DIR="/var/log/moltbot"
MOLTBOT_CONFIG_DIR="/etc/moltbot"
INSTALL_DIR="/opt/moltbot"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# ===== 检查 root 权限 =====
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "此脚本需要 root 权限运行"
        exit 1
    fi
}

# ===== 创建系统用户 =====
create_user() {
    log_info "创建 Moltbot 系统用户..."
    if ! id "$MOLTBOT_USER" &>/dev/null; then
        useradd -r -s /bin/bash -d "$MOLTBOT_HOME" "$MOLTBOT_USER"
        log_info "用户 $MOLTBOT_USER 创建成功"
    else
        log_warn "用户 $MOLTBOT_USER 已存在"
    fi
}

# ===== 创建目录结构 =====
create_directories() {
    log_info "创建目录结构..."
    mkdir -p "$MOLTBOT_HOME"/{workspace,sessions,credentials}
    mkdir -p "$MOLTBOT_LOG_DIR"
    mkdir -p "$MOLTBOT_CONFIG_DIR"
    mkdir -p "$INSTALL_DIR"

    # 设置权限
    chown -R "$MOLTBOT_USER:$MOLTBOT_USER" "$MOLTBOT_HOME"
    chown -R "$MOLTBOT_USER:$MOLTBOT_USER" "$MOLTBOT_LOG_DIR"
    chmod 750 "$MOLTBOT_HOME"
    chmod 750 "$MOLTBOT_LOG_DIR"

    log_info "目录创建完成"
}

# ===== 安装 Moltbot =====
install_moltbot() {
    log_info "安装 Moltbot..."

    # 检查是否已安装
    if [ -d "$INSTALL_DIR/moltbot" ]; then
        log_warn "Moltbot 似乎已安装在 $INSTALL_DIR/moltbot"
        read -p "是否重新安装? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            return
        fi
        rm -rf "$INSTALL_DIR/moltbot"
    fi

    # 这里假设从现有目录复制或从 git 克隆
    if [ -d "/root/moltbot" ]; then
        cp -r /root/moltbot "$INSTALL_DIR/"
        chown -R "$MOLTBOT_USER:$MOLTBOT_USER" "$INSTALL_DIR/moltbot"
        log_info "Moltbot 安装完成"
    else
        log_error "请先在 /root/moltbot 准备 Moltbot 源码"
        exit 1
    fi
}

# ===== 配置环境变量 =====
setup_environment() {
    log_info "配置环境变量..."

    cat > "$MOLTBOT_CONFIG_DIR/environment" <<EOF
# Moltbot 环境变量
# 注意：不要在版本控制中提交实际密钥

# Anthropic API 密钥 (必填)
export ANTHROPIC_API_KEY="your-api-key-here"

# Gateway Token (必填，建议使用强密码)
export CLAWDBOT_GATEWAY_TOKEN="your-gateway-token-here"

# 可选：自定义配置文件路径
export CLAWDBOT_STATE_DIR="$MOLTBOT_HOME"
export CLAWDBOT_CONFIG_FILE="$MOLTBOT_CONFIG_DIR/moltbot.json"
EOF

    chmod 600 "$MOLTBOT_CONFIG_DIR/environment"
    chown "$MOLTBOT_USER:$MOLTBOT_USER" "$MOLTBOT_CONFIG_DIR/environment"

    log_warn "请编辑 $MOLTBOT_CONFIG_DIR/environment 并设置您的 API 密钥"
}

# ===== 安装 systemd 服务 =====
install_service() {
    log_info "安装 systemd 服务..."

    cat > /etc/systemd/system/moltbot-gateway.service <<EOF
[Unit]
Description=Moltbot Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$MOLTBOT_USER
Group=$MOLTBOT_USER
WorkingDirectory=$INSTALL_DIR/moltbot
EnvironmentFile=$MOLTBOT_CONFIG_DIR/environment
ExecStart=/usr/bin/node $INSTALL_DIR/moltbot/dist/index.js gateway
Restart=on-failure
RestartSec=10
StandardOutput=append:$MOLTBOT_LOG_DIR/gateway.log
StandardError=append:$MOLTBOT_LOG_DIR/gateway-error.log

# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$MOLTBOT_HOME $MOLTBOT_LOG_DIR $MOLTBOT_CONFIG_DIR

# 资源限制
LimitNOFILE=65536
MemoryMax=2G
CPUQuota=200%

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    log_info "systemd 服务安装完成"
}

# ===== 配置 logrotate =====
setup_logrotate() {
    log_info "配置日志轮转..."

    cat > /etc/logrotate.d/moltbot <<EOF
$MOLTBOT_LOG_DIR/*.log {
    daily
    rotate 30
    compress
    delaycompress
    notifempty
    create 0640 $MOLTBOT_USER $MOLTBOT_USER
    sharedscripts
    postrotate
        systemctl reload moltbot-gateway.service >/dev/null 2>&1 || true
    endscript
}
EOF

    log_info "日志轮转配置完成"
}

# ===== 配置防火墙 =====
setup_firewall() {
    log_info "配置防火墙..."

    if command -v ufw &> /dev/null; then
        ufw allow 18789/tcp comment 'Moltbot Gateway'
        log_info "UFW 防火墙规则已添加"
    elif command -v firewall-cmd &> /dev/null; then
        firewall-cmd --permanent --add-port=18789/tcp
        firewall-cmd --reload
        log_info "firewalld 防火墙规则已添加"
    else
        log_warn "未检测到防火墙，请手动开放端口 18789"
    fi
}

# ===== 安装 Nginx 反向代理 =====
install_nginx() {
    log_info "配置 Nginx 反向代理..."

    if ! command -v nginx &> /dev/null; then
        log_warn "Nginx 未安装，跳过反向代理配置"
        return
    fi

    cat > /etc/nginx/sites-available/moltbot <<'EOF'
# Moltbot Gateway 反向代理配置
server {
    listen 80;
    server_name moltbot.yourcompany.com;

    # 强制 HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name moltbot.yourcompany.com;

    # SSL 证书配置 (使用 Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/moltbot.yourcompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/moltbot.yourcompany.com/privkey.pem;

    # SSL 安全配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # 日志
    access_log /var/log/nginx/moltbot-access.log;
    error_log /var/log/nginx/moltbot-error.log;

    # 反向代理到 Moltbot Gateway
    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_to;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 300s;

        # 缓冲禁用 (流式响应需要)
        proxy_buffering off;
    }

    # 健康检查端点
    location /health {
        proxy_pass http://127.0.0.1:18789/health;
        access_log off;
    }
}
EOF

    log_info "Nginx 配置文件已创建: /etc/nginx/sites-available/moltbot"
    log_warn "请修改 server_name 并启用配置: ln -s /etc/nginx/sites-available/moltbot /etc/nginx/sites-enabled/"
}

# ===== 主函数 =====
main() {
    log_info "开始安装 Moltbot 企业版..."

    check_root
    create_user
    create_directories
    install_moltbot
    setup_environment
    install_service
    setup_logrotate
    setup_firewall
    install_nginx

    echo ""
    log_info "安装完成！"
    echo ""
    echo "后续步骤："
    echo "1. 编辑环境变量文件："
    echo "   vim $MOLTBOT_CONFIG_DIR/environment"
    echo ""
    echo "2. 复制企业配置文件："
    echo "   cp enterprise-config.json5 $MOLTBOT_CONFIG_DIR/moltbot.json"
    echo ""
    echo "3. 配置 Nginx（如果使用）："
    echo "   vim /etc/nginx/sites-available/moltbot"
    echo "   ln -s /etc/nginx/sites-available/moltbot /etc/nginx/sites-enabled/"
    echo "   nginx -t && systemctl reload nginx"
    echo ""
    echo "4. 启动服务："
    echo "   systemctl enable --now moltbot-gateway.service"
    echo ""
    echo "5. 查看状态："
    echo "   systemctl status moltbot-gateway.service"
    echo "   journalctl -u moltbot-gateway.service -f"
}

# 运行主函数
main "$@"
