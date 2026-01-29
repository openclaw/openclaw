# Moltbot 企业级部署指南

## 目录
- [架构概览](#架构概览)
- [部署方案](#部署方案)
- [安全最佳实践](#安全最佳实践)
- [运维管理](#运维管理)
- [监控和告警](#监控和告警)
- [故障排查](#故障排查)

---

## 架构概览

### 推荐架构

```
                    ┌─────────────────┐
                    │   员工浏览器    │
                    └────────┬────────┘
                             │ HTTPS
                    ┌────────▼────────┐
                    │  Nginx/Caddy    │ ← SSL 终止、访问日志
                    │  反向代理       │
                    └────────┬────────┘
                             │ HTTP
                    ┌────────▼────────┐
                    │ Moltbot Gateway │ ← 端口 18789
                    │  - Token 认证   │
                    │  - 会话隔离     │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  LLM API        │
                    │  (BigModel)     │
                    └─────────────────┘
```

---

## 部署方案

### 方案 A: 单服务器部署 (适合 <50 用户)

**硬件要求:**
- CPU: 4 核心以上
- 内存: 8GB 以上
- 磁盘: 50GB SSD

**优点:**
- 部署简单
- 维护成本低
- 适合小型团队

**缺点:**
- 单点故障
- 扩展性有限

### 方案 B: 高可用部署 (适合 50+ 用户)

**架构:**
- 负载均衡器 (Nginx/HAProxy)
- 2+ 个 Moltbot Gateway 实例
- 共享存储 (NFS/云存储)
- Redis (可选，用于会话共享)

**优点:**
- 高可用性
- 水平扩展
- 负载分散

---

## 安全最佳实践

### 1. 认证和授权

#### Gateway Token 认证
```json5
{
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "${CLAWDBOT_GATEWAY_TOKEN}"  // 从环境变量读取
    }
  }
}
```

**安全建议:**
- Token 长度至少 32 字符
- 定期轮换 Token (每月/季度)
- 不要在代码中硬编码
- 使用环境变量或密钥管理系统

### 2. 网络安全

#### 反向代理配置
```nginx
# /etc/nginx/sites-available/moltbot
server {
    listen 443 ssl http2;
    server_name moltbot.company.com;

    # SSL 配置
    ssl_certificate /etc/letsencrypt/live/moltbot.company.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/moltbot.company.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # 代理到 Moltbot
    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_to;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

#### 防火墙规则
```bash
# 只允许特定网络访问
ufw allow from 10.0.0.0/8 to any port 18789
ufw allow from 172.16.0.0/12 to any port 18789
```

### 3. API 密钥管理

#### 使用环境变量
```bash
# /etc/moltbot/environment
export ANTHROPIC_API_KEY="sk-ant-..."
export CLAWDBOT_GATEWAY_TOKEN="your-secure-token-here"
```

#### 文件权限
```bash
chmod 600 /etc/moltbot/environment
chmod 640 /etc/moltbot/moltbot.json
chown root:moltbot /etc/moltbot/*
```

### 4. 会话隔离

#### 多用户会话隔离配置
```json5
{
  "session": {
    "dmScope": "per-channel-peer",  // 每个用户独立会话
    "reset": {
      "mode": "idle",
      "idleMinutes": 120
    }
  }
}
```

**说明:**
- `per-channel-peer`: 按频道+用户隔离
- `per-peer`: 按用户隔离（跨频道共享）
- `main`: 所有用户共享（不推荐多用户场景）

### 5. 文件系统安全

```bash
# 设置严格的文件权限
chmod 700 /var/lib/moltbot
chmod 700 /var/lib/moltbot/sessions
chmod 600 /var/lib/moltbot/sessions/*.jsonl

# 确保 Moltbot 运行在专用用户下
useradd -r moltbot
```

### 6. 日志和审计

#### 敏感信息脱敏
```json5
{
  "logging": {
    "redactSensitive": "tools",  // 过滤工具调用中的敏感信息
    "file": {
      "enabled": true,
      "path": "/var/log/moltbot/gateway.log"
    }
  }
}
```

#### 审计日志
```bash
# 定期运行安全审计
moltbot security audit --deep

# 查看异常访问
grep -i "unauthorized\|forbidden" /var/log/moltbot/gateway.log
```

---

## 运维管理

### 1. 服务管理

#### 启动和停止
```bash
# 启动服务
systemctl start moltbot-gateway.service

# 停止服务
systemctl stop moltbot-gateway.service

# 重启服务
systemctl restart moltbot-gateway.service

# 查看状态
systemctl status moltbot-gateway.service
```

#### 查看日志
```bash
# 实时日志
journalctl -u moltbot-gateway.service -f

# 最近 100 行
journalctl -u moltbot-gateway.service -n 100

# 按时间过滤
journalctl -u moltbot-gateway.service --since "1 hour ago"
```

### 2. 配置更新

#### 热更新配置
```bash
# 通过 RPC 更新配置
moltbot gateway call config.get --params '{}'
moltbot gateway call config.patch --params '{
  "raw": "{ agents: { defaults: { maxConcurrent: 16 } } }",
  "baseHash": "<hash-from-config.get>"
}'
```

#### 手动更新
```bash
# 编辑配置文件
vim /etc/moltbot/moltbot.json

# 重启服务
systemctl restart moltbot-gateway.service
```

### 3. 证书管理

#### Let's Encrypt 自动续期
```bash
# 安装 certbot
apt install certbot python3-certbot-nginx

# 获取证书
certbot --nginx -d moltbot.company.com

# 自动续期已通过 cron 配置
certbot renew --dry-run
```

### 4. 备份策略

#### 需要备份的内容
```bash
#!/bin/bash
# backup-moltbot.sh

BACKUP_DIR="/backup/moltbot/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"

# 备份配置
cp /etc/moltbot/moltbot.json "$BACKUP_DIR/"
cp /etc/moltbot/environment "$BACKUP_DIR/"

# 备份会话
tar -czf "$BACKUP_DIR/sessions.tar.gz" /var/lib/moltbot/sessions/

# 备份凭证
tar -czf "$BACKUP_DIR/credentials.tar.gz" /var/lib/moltbot/credentials/

# 清理 30 天前的备份
find /backup/moltbot -type d -mtime +30 -exec rm -rf {} \;
```

---

## 监控和告警

### 1. 健康检查

#### 内置健康检查
```bash
# 检查服务健康
curl http://127.0.0.1:18789/health

# 检查模型状态
moltbot models status
```

### 2. 监控指标

#### 关键指标
- 服务运行时间
- 内存使用率
- CPU 使用率
- 活跃会话数
- API 调用延迟
- 错误率

#### Prometheus 监控示例
```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'moltbot'
    static_configs:
      - targets: ['localhost:18789']
    metrics_path: '/metrics'
```

### 3. 告警配置

#### 常见告警规则
```yaml
# alerting.yml
groups:
  - name: moltbot
    rules:
      - alert: MoltbotServiceDown
        expr: up{job="moltbot"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Moltbot service is down"

      - alert: MoltbotHighMemory
        expr: process_resident_memory_bytes{job="moltbot"} > 2GB
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Moltbot memory usage is high"
```

---

## 故障排查

### 常见问题

#### 1. 服务无法启动

**检查步骤:**
```bash
# 查看服务状态
systemctl status moltbot-gateway.service

# 查看详细日志
journalctl -u moltbot-gateway.service -n 100 --no-pager

# 检查配置文件
moltbot doctor --fix
```

**常见原因:**
- 配置文件语法错误
- 端口被占用
- 环境变量未设置
- 权限问题

#### 2. 认证失败

**检查:**
```bash
# 验证 Token
grep "CLAWDBOT_GATEWAY_TOKEN" /etc/moltbot/environment

# 检查日志
grep "unauthorized\|auth" /var/log/moltbot/gateway.log
```

#### 3. API 调用失败

**检查:**
```bash
# 验证 API 密钥
grep "ANTHROPIC_API_KEY" /etc/moltbot/environment

# 测试 API 连接
curl -X POST https://open.bigmodel.cn/api/anthropic/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-5","max_tokens":100,"messages":[{"role":"user","content":"hello"}]}'
```

#### 4. 性能问题

**排查:**
```bash
# 检查资源使用
top -p $(pgrep moltbot-gateway)

# 查看活跃会话
moltbot sessions list

# 检查并发配置
grep "maxConcurrent" /etc/moltbot/moltbot.json
```

---

## 性能优化

### 1. 并发调优

```json5
{
  "agents": {
    "defaults": {
      "maxConcurrent": 16,  // 根据 CPU 核心数调整
      "subagents": {
        "maxConcurrent": 32
      }
    }
  }
}
```

### 2. 缓存优化

```json5
{
  "agents": {
    "defaults": {
      "models": {
        "anthropic/claude-opus-4-5": {
          "params": {
            "cacheControlTtl": "1h"  // 启用缓存
          }
        }
      }
    }
  }
}
```

### 3. 资源限制

```ini
# /etc/systemd/system/moltbot-gateway.service
[Service]
MemoryMax=4G
CPUQuota=300%
LimitNOFILE=65536
```

---

## 成本控制

### 1. 使用量监控

```bash
# 查看模型使用统计
moltbot models usage

# 按用户统计
awk '/user:/ {print}' /var/log/moltbot/gateway.log | sort | uniq -c
```

### 2. 预算告警

配置预算限制并设置告警：
```json5
{
  "models": {
    "providers": {
      "anthropic": {
        "budget": {
          "daily": 100,  // 每日限额 (美元)
          "alert": true
        }
      }
    }
  }
}
```

---

## 附录

### A. 配置文件模板

参见 [enterprise-config.json5](enterprise-config.json5)

### B. 部署脚本

参见 [setup-enterprise.sh](setup-enterprise.sh)

### C. 相关文档

- [Moltbot 官方文档](https://docs.molt.bot)
- [安全最佳实践](https://docs.molt.bot/gateway/security)
- [配置参考](https://docs.molt.bot/gateway/configuration)
