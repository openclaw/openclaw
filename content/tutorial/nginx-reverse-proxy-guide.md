# OpenClaw + nginx 反向代理配置指南

> 🔧 配置难度：中级 | ⏱️ 预计时间：15-30 分钟 | 适用：Linux/macOS 服务器

---

## 目录

- [前置要求](#前置要求)
- [方案概览](#方案概览)
- [基础反向代理配置](#基础反向代理配置)
- [HTTPS + TLS 配置](#https--tls-配置)
- [Token 认证配置](#token-认证配置)
- [完整配置示例](#完整配置示例)
- [安全加固建议](#安全加固建议)
- [故障排除](#故障排除)

---

## 前置要求

### 软件环境

| 组件 | 版本要求 | 说明 |
|------|---------|------|
| nginx | ≥ 1.18 | 主流 Linux 发行版均支持 |
| OpenClaw Gateway | ≥ 2026.4.x | 本教程适配新版 Gateway |
| SSL 证书 | Let's Encrypt 或商业证书 | 用于 HTTPS |
| 域名 | 已解析到服务器 IP | A 记录 |

### 服务器规格（推荐）

| 用途 | 最低配置 | 推荐配置 |
|------|---------|---------|
| 个人/团队使用 | 1 CPU / 1GB RAM | 2 CPU / 2GB RAM |
| 小型组织 | 2 CPU / 4GB RAM | 4 CPU / 8GB RAM |

---

## 方案概览

```
                    ┌─────────────────────────────────────────┐
                    │              nginx (443/80)              │
                    │  ┌─────────────┐  ┌──────────────────┐   │
用户请求 ──────────►│  │ TLS 终止    │  │ Token 认证中间件  │   │
                    │  └─────────────┘  └──────────────────┘   │
                    │         │                    │           │
                    │         ▼                    ▼           │
                    │  ┌───────────────────────────────────┐   │
                    │  │        反向代理到 localhost       │   │
                    │  │         ws://127.0.0.1:18789     │   │
                    │  └───────────────────────────────────┘   │
                    └─────────────────────────────────────────┘
                                       │
                                       ▼
                              ┌──────────────────┐
                              │  OpenClaw        │
                              │  Gateway         │
                              │  (localhost:18789)│
                              └──────────────────┘
```

### 为什么用 nginx？

| 优势 | 说明 |
|------|------|
| 🔐 HTTPS 终止 | nginx 处理 SSL/TLS，Gateway 无需操心证书 |
| 🛡️ 访问控制 | IP 白名单、Token 认证、速率限制 |
| 🔄 负载均衡 | 多 Gateway 实例时轮询分发 |
| 📝 日志记录 | 集中式访问日志，便于分析 |
| 🚀 性能优化 | 静态资源缓存、压缩传输 |

---

## 基础反向代理配置

### Step 1：安装 nginx

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install nginx
```

**macOS (Homebrew):**
```bash
brew install nginx
```

**CentOS/RHEL:**
```bash
sudo yum install nginx
```

### Step 2：检查 Gateway 端口

```bash
# 查看 Gateway 配置端口
openclaw gateway status

# 默认端口 18789，确认服务正在运行
curl http://127.0.0.1:18789/health || echo "Gateway 未运行"
```

### Step 3：创建 nginx 站点配置

```bash
# Ubuntu/Debian
sudo nano /etc/nginx/sites-available/openclaw

# macOS (Homebrew)
nano /usr/local/etc/nginx/servers/openclaw.conf
```

### Step 4：基础反向代理配置

```nginx
server {
    listen 80;
    server_name your-domain.com;  # 替换为你的域名

    # 日志
    access_log /var/log/nginx/openclaw_access.log;
    error_log /var/log/nginx/openclaw_error.log;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        
        # WebSocket 支持（必需！）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # 原始请求信息
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # WebSocket 超时（长连接）
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

### Step 5：启用配置并重启

**Ubuntu/Debian:**
```bash
# 启用站点
sudo ln -s /etc/nginx/sites-available/openclaw /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重载 nginx
sudo systemctl reload nginx
```

**macOS:**
```bash
# 测试配置
nginx -t

# 重载配置
brew services restart nginx
# 或
nginx -s reload
```

### Step 6：测试访问

```bash
# HTTP 测试
curl -I http://your-domain.com/health

# WebSocket 测试
curl --include \
     --no-buffer \
     --header "Connection: Upgrade" \
     --header "Upgrade: websocket" \
     --header "Sec-WebSocket-Version: 13" \
     --header "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
     http://your-domain.com/
```

---

## HTTPS + TLS 配置

### 使用 Let's Encrypt（免费）

```bash
# 安装 certbot
sudo apt install certbot python3-certbot-nginx

# 获取证书（自动配置 nginx）
sudo certbot --nginx -d your-domain.com

# 自动续期测试
sudo certbot renew --dry-run
```

### 手动 HTTPS 配置

```nginx
server {
    listen 80;
    server_name your-domain.com;
    # 强制 HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL 证书配置
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # SSL 安全配置
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:50m;
    ssl_session_tickets off;

    # 现代加密套件
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # HSTS（可选但推荐）
    add_header Strict-Transport-Security "max-age=63072000" always;

    # OCSP Stapling
    ssl_stapling on;
    ssl_stapling_verify on;
    resolver 8.8.8.8 8.8.4.4 valid=300s;
    resolver_timeout 5s;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

---

## Token 认证配置

### 为什么需要 Token 认证？

| 风险 | 说明 |
|------|------|
| 🔓 未授权访问 | 无认证时任何人都可以访问你的 Gateway |
| 💰 资源消耗 | 恶意用户可能消耗你的 API 配额 |
| 📊 滥用风险 | 可能被用于发送垃圾信息或攻击 |

### nginx HTTP Basic Auth + Token

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL 配置（省略，同上）
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    # 生成密码文件
    # printf "your-user:$(openssl passwd -apr1 your-password)\n" | sudo tee /etc/nginx/.htpasswd

    # 路径：/openclaw/ 需要认证
    location /openclaw/ {
        # 认证配置
        auth_basic "OpenClaw Gateway - 请输入凭证";
        auth_basic_user_file /etc/nginx/.htpasswd;
        
        proxy_pass http://127.0.0.1:18789/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # 其他路径也可以受保护
    location /api/ {
        auth_basic "API Access";
        auth_basic_user_file /etc/nginx/.htpasswd;
        
        proxy_pass http://127.0.0.1:18789/;
        # ... 其他 proxy_set_header
    }

    # 公开路径（如健康检查）
    location /health {
        auth_basic off;
        proxy_pass http://127.0.0.1:18789/health;
    }
}
```

### Token 认证（推荐：更安全）

使用 JWT 或自定义 Header Token：

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL 配置...
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    # 预设的 Token（建议使用复杂的随机字符串）
    set $valid_token "sk-openclaw-your-secure-token-here";

    location / {
        # 从 Header 或 Query String 获取 Token
        set $token "";

        # 方式1: Authorization Header
        if ($http_authorization ~ ^Bearer\s+(.+)$) {
            set $token $1;
        }

        # 方式2: Query String (?token=xxx)
        if ($arg_token != "") {
            set $token $arg_token;
        }

        # Token 验证
        if ($token != $valid_token) {
            return 401 '{"error": "Unauthorized", "message": "Invalid or missing token"}';
        }

        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-OpenClaw-Token $token;  # 传递给 Gateway
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # 健康检查（无需认证）
    location /health {
        auth_basic off;
        proxy_pass http://127.0.0.1:18789/health;
    }
}
```

### 创建安全的 Token

```bash
# 方法1: OpenSSL 随机生成
openssl rand -base64 32

# 方法2: 使用 /dev/urandom
head -c 32 /dev/urandom | base64

# 示例输出: sk-openclaw-Mr7KpL9xWn2VQjZ5Ym8BfNsTdGh3Re6DhCa1Op4Kl0=
```

---

## 完整配置示例

以下是生产环境推荐的完整 nginx 配置：

```nginx
# /etc/nginx/sites-available/openclaw

# HTTP → HTTPS 重定向
server {
    listen 80;
    listen [::]:80;
    server_name your-domain.com;
    
    # Let's Encrypt 验证路径（certbot 自动管理）
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    
    # 其他请求重定向到 HTTPS
    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS 主服务器
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name your-domain.com;

    # ─────────────────────────────────────────────
    # SSL 证书配置
    # ─────────────────────────────────────────────
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    
    # SSL 安全强化
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:50m;
    ssl_session_tickets off;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    
    # HSTS
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    
    # OCSP Stapling
    ssl_stapling on;
    ssl_stapling_verify on;
    resolver 8.8.8.8 8.8.4.4 valid=300s;
    resolver_timeout 5s;

    # ─────────────────────────────────────────────
    # 日志配置
    # ─────────────────────────────────────────────
    access_log /var/log/nginx/openclaw_access.log combined;
    error_log /var/log/nginx/openclaw_error.log warn;

    # ─────────────────────────────────────────────
    # 安全头
    # ─────────────────────────────────────────────
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;

    # ─────────────────────────────────────────────
    # 速率限制
    # ─────────────────────────────────────────────
    limit_req_zone $binary_remote_addr zone=openclaw_limit:10m rate=10r/s;
    limit_req_status 429;
    limit_conn_zone $binary_remote_addr zone=conn_openclaw:10m;
    limit_conn_status 429;

    # ─────────────────────────────────────────────
    # 路径配置
    # ─────────────────────────────────────────────
    
    # 健康检查（无需认证）
    location /health {
        auth_basic off;
        proxy_pass http://127.0.0.1:18789/health;
        proxy_http_version 1.1;
    }

    # WebSocket 路径
    location /ws {
        # Token 验证
        set $valid_token "sk-openclaw-your-secure-token-here";
        set $token "";
        
        if ($http_authorization ~ ^Bearer\s+(.+)$) {
            set $token $1;
        }
        if ($arg_token != "") {
            set $token $arg_token;
        }
        
        if ($token != $valid_token) {
            return 401 '{"error": "Unauthorized"}';
        }

        # 速率限制
        limit_req zone=openclaw_limit burst=20 nodelay;
        limit_conn conn_openclaw 10;

        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # 默认路径（Gateway Web UI/API）
    location / {
        # Token 验证
        set $valid_token "sk-openclaw-your-secure-token-here";
        set $token "";
        
        if ($http_authorization ~ ^Bearer\s+(.+)$) {
            set $token $1;
        }
        if ($arg_token != "") {
            set $token $arg_token;
        }
        
        if ($token != $valid_token) {
            return 401 '{"error": "Unauthorized"}';
        }

        # 速率限制
        limit_req zone=openclaw_limit burst=20 nodelay;
        limit_conn conn_openclaw 10;

        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

---

## 安全加固建议

### 1. IP 白名单

```nginx
# 只允许特定 IP 访问
location / {
    allow 203.0.113.0/24;  # 你的 IP 范围
    allow 198.51.100.5;    # 特定 IP
    deny all;              # 拒绝其他

    proxy_pass http://127.0.0.1:18789;
    # ...
}
```

### 2. 使用 fail2ban 防护

```bash
# 安装 fail2ban
sudo apt install fail2ban

# 创建 jail 配置
sudo nano /etc/fail2ban/jail.d/openclaw.conf
```

```ini
[nginx-openclaw-auth]
enabled = true
port = 443
protocol = https
filter = nginx-openclaw-auth
logpath = /var/log/nginx/openclaw_error.log
maxretry = 5
findtime = 600
bantime = 3600
action = iptables-allports
```

### 3. 定期更新 SSL 证书

```bash
# certbot 自动续期（推荐）
sudo certbot renew

# 或添加 cron 任务
sudo crontab -e
# 添加: 0 3 * * * certbot renew --quiet
```

---

## 故障排除

### 问题 1：502 Bad Gateway

```bash
# 1. 检查 Gateway 是否运行
curl http://127.0.0.1:18789/health

# 2. 检查 nginx 错误日志
tail -f /var/log/nginx/openclaw_error.log

# 3. 检查 Gateway 日志
openclaw gateway logs
```

### 问题 2：WebSocket 连接失败

```nginx
# 确认以下 header 设置正确
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 86400s;
```

```bash
# 测试 WebSocket
curl --include \
     --header "Connection: Upgrade" \
     --header "Upgrade: websocket" \
     http://your-domain.com/
```

### 问题 3：SSL 证书错误

```bash
# 检查证书
openssl s_client -connect your-domain.com:443 -servername your-domain.com

# 续期 Let's Encrypt
sudo certbot renew --force-renewal
```

### 问题 4：Token 认证不生效

```bash
# 确认 Header 格式正确
curl -H "Authorization: Bearer sk-openclaw-your-token" https://your-domain.com/

# 检查 nginx 变量
tail -f /var/log/nginx/openclaw_access.log
```

---

## 相关资源

| 资源 | 链接 |
|------|------|
| 📖 OpenClaw 官方文档 | https://docs.openclaw.ai |
| 🔧 nginx 官方文档 | https://nginx.org/en/docs/ |
| 🔐 Let's Encrypt | https://letsencrypt.org |
| 🐛 GitHub Issue #71258 | https://github.com/openclaw/openclaw/issues/71258 |
| 💬 OpenClaw Discord | https://discord.com/invite/clawd |

---

## 更新日志

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-25 | 1.0 | 初始版本 |

---

*🦦 文档生成：OpenClaw Assistant | 来源：GitHub Issue #71258 | 审核版本：v1.0*
