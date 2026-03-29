# OpenClaw 部署指南

本文档介绍如何在不同环境中部署 OpenClaw。

## 本地部署

### npm 全局安装

```bash
# 安装
npm install -g openclaw

# 配置
openclaw setup

# 启动
openclaw start

# 查看状态
openclaw status
```

### Docker 部署

```bash
# 拉取镜像
docker pull openclaw/openclaw:latest

# 运行
docker run -d \
  --name openclaw \
  -p 8080:8080 \
  -v ~/.openclaw:/root/.openclaw \
  -e GATEWAY_TOKEN=your-token \
  openclaw/openclaw:latest
```

## 生产环境部署

### 使用 Docker Compose

```yaml
# docker-compose.prod.yaml
version: '3.8'
services:
  openclaw:
    image: openclaw/openclaw:latest
    restart: always
    ports:
      - "8080:8080"
    environment:
      - GATEWAY_TOKEN=${GATEWAY_TOKEN}
      - DEFAULT_MODEL=${DEFAULT_MODEL}
    volumes:
      - ./data:/data
      - openclaw-config:/root/.openclaw
    healthcheck:
      test: ["CMD", "openclaw", "status"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  openclaw-config:
```

启动:
```bash
docker-compose -f docker-compose.prod.yaml up -d
```

### 使用 Systemd (Linux)

```ini
# /etc/systemd/system/openclaw.service
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/home/openclaw
ExecStart=/usr/bin/openclaw start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable openclaw
sudo systemctl start openclaw
```

## 云平台部署

### Railway

1. Fork OpenClaw 仓库
2. 在 Railway 中导入项目
3. 设置环境变量
4. 部署

### Render

```yaml
# render.yaml
services:
  - type: web
    name: openclaw
    env: node
    buildCommand: npm install -g openclaw
    startCommand: openclaw start
    envVars:
      - key: GATEWAY_TOKEN
        generateValue: true
```

### VPS 部署

```bash
# 1. 安装 Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 安装 OpenClaw
sudo npm install -g openclaw

# 3. 配置
openclaw setup

# 4. 使用 PM2 运行
sudo npm install -g pm2
pm2 start openclaw -- start
pm2 save
pm2 startup
```

## SSL/HTTPS 配置

### 使用 Nginx 反向代理

```nginx
# /etc/nginx/sites-available/openclaw
server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 使用 Caddy

```Caddyfile
your-domain.com {
    reverse_proxy localhost:8080
}
```

## 监控与日志

### PM2 监控

```bash
pm2 install pm2-logrotation
pm2 install pm2-prometheus
pm2 monitor
```

### 日志管理

```bash
# 查看日志
openclaw logs

# 导出日志
openclaw logs --export logs.txt

# 使用 journald
journalctl -u openclaw -f
```

## 备份与恢复

### 备份配置

```bash
tar -czf openclaw-backup.tar.gz \
  ~/.openclaw/config.yaml \
  ~/.openclaw/skills/ \
  ~/.openclaw/memory/
```

### 恢复配置

```bash
tar -xzf openclaw-backup.tar.gz -C ~/
```

## 安全建议

1. 使用强 Gateway Token
2. 启用 HTTPS
3. 配置防火墙规则
4. 定期更新 OpenClaw
5. 监控异常访问

---

部署问题请参考故障排除指南。
