# Moltbot 企业部署文件

本目录包含 Moltbot 企业级部署所需的所有文件和文档。

## 📁 文件说明

### 配置文件
- **[enterprise-config.json5](enterprise-config.json5)** - 生产级配置模板
- **[.env.example](.env.example)** - Docker 环境变量模板
- **[docker-compose.yml](docker-compose.yml)** - Docker Compose 配置

### 脚本
- **[setup-enterprise.sh](setup-enterprise.sh)** - 自动化部署脚本 (Linux/Ubuntu)

### 文档
- **[ENTERPRISE.md](ENTERPRISE.md)** - 完整企业部署指南
- **[QUICKSTART.md](QUICKSTART.md)** - 5分钟快速部署指南
- **[security-checklist.md](security-checklist.md)** - 安全检查清单

## 🚀 快速开始

### 方案 1: 自动化脚本部署 (推荐用于 Ubuntu/Debian)

```bash
# 1. 运行安装脚本
chmod +x setup-enterprise.sh
sudo ./setup-enterprise.sh

# 2. 配置环境变量
sudo vim /etc/moltbot/environment

# 3. 启动服务
sudo systemctl enable --now moltbot-gateway.service
```

### 方案 2: Docker 部署

```bash
# 1. 复制环境变量文件
cp .env.example .env

# 2. 编辑 .env 文件，填写 API 密钥和 Token
vim .env

# 3. 启动服务
docker-compose up -d

# 4. 查看日志
docker-compose logs -f
```

### 方案 3: 手动部署

参见 [ENTERPRISE.md](ENTERPRISE.md) 中的详细步骤。

## 📋 部署前检查清单

在部署到生产环境前，请确认以下项目：

- [ ] 已设置强密码的 Gateway Token
- [ ] API 密钥已通过环境变量配置
- [ ] 配置了会话隔离 (`per-channel-peer`)
- [ ] 启用了 Gateway 认证
- [ ] 配置了 HTTPS/SSL
- [ ] 设置了防火墙规则
- [ ] 配置了日志轮转
- [ ] 设置了定期备份
- [ ] 运行了安全审计 (`moltbot security audit`)

完整检查清单请参考 [security-checklist.md](security-checklist.md)。

## 🔧 配置说明

### 必需配置

1. **环境变量** (必须)
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   export CLAWDBOT_GATEWAY_TOKEN="secure-token-32chars"
   ```

2. **会话隔离** (多用户场景必须)
   ```json5
   {
     "session": {
       "dmScope": "per-channel-peer"
     }
   }
   ```

3. **Gateway 认证** (必须)
   ```json5
   {
     "gateway": {
       "auth": {
         "mode": "token",
         "token": "${CLAWDBOT_GATEWAY_TOKEN}"
       }
     }
   }
   ```

### 推荐配置

- HTTPS 反向代理 (Nginx/Caddy)
- 日志轮转 (logrotate)
- 系统服务管理 (systemd)
- 资源限制 (Memory/CPU)
- 健康检查监控

## 📊 规模建议

| 用户规模 | 服务器配置 | 部署方案 |
|---------|----------|---------|
| < 20    | 4核/8GB  | 单服务器 |
| 20-50   | 8核/16GB | 单服务器 |
| 50-200  | 16核/32GB | 负载均衡 + 2实例 |
| 200+    | 集群     | 负载均衡 + 多实例 + Redis |

## 🛡️ 安全建议

1. **永远不要**将 API 密钥提交到版本控制
2. **使用环境变量**存储敏感信息
3. **定期轮换**密钥和 Token (建议每月)
4. **启用 HTTPS** 生产环境
5. **配置会话隔离** 多用户场景
6. **定期备份** 配置和数据
7. **运行安全审计** 定期检查

## 📞 获取帮助

- 📖 [完整部署指南](ENTERPRISE.md)
- ⚡ [快速开始](QUICKSTART.md)
- 🔒 [安全检查清单](security-checklist.md)
- 🐛 [问题反馈](https://github.com/m1heng/moltbot/issues)

## 📝 维护说明

### 日常维护

```bash
# 查看服务状态
systemctl status moltbot-gateway.service

# 查看日志
journalctl -u moltbot-gateway.service -f

# 安全审计
moltbot security audit

# 查看模型状态
moltbot models status
```

### 更新配置

```bash
# 编辑配置
sudo vim /etc/moltbot/moltbot.json

# 重启服务
sudo systemctl restart moltbot-gateway.service
```

### 备份

```bash
# 备份配置和数据
tar -czf moltbot-backup-$(date +%Y%m%d).tar.gz \
  /etc/moltbot \
  /var/lib/moltbot
```

## ⚠️ 重要提示

1. 本目录中的配置文件仅供参考，实际部署时请根据您的环境调整
2. 请务必修改所有默认值和示例值（密码、Token、域名等）
3. 生产环境部署前请先在测试环境验证
4. 定期检查并更新到最新版本以获取安全补丁

## 📄 许可证

本部署脚本和配置遵循 Moltbot 项目的开源许可证。
