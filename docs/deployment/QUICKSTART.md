# Moltbot 企业部署快速参考

## 🚀 5 分钟快速部署

```bash
# 1. 运行安装脚本
cd /root/moltbot/docs/deployment
chmod +x setup-enterprise.sh
sudo ./setup-enterprise.sh

# 2. 配置环境变量
sudo vim /etc/moltbot/environment
# 设置 ANTHROPIC_API_KEY 和 CLAWDBOT_GATEWAY_TOKEN

# 3. 复制配置文件
sudo cp enterprise-config.json5 /etc/moltbot/moltbot.json

# 4. 启动服务
sudo systemctl enable --now moltbot-gateway.service

# 5. 验证
sudo systemctl status moltbot-gateway.service
curl http://127.0.0.1:18789/health
```

---

## 🔑 关键配置

### 环境变量 (必须)
```bash
# /etc/moltbot/environment
export ANTHROPIC_API_KEY="sk-ant-..."
export CLAWDBOT_GATEWAY_TOKEN="secure-token-32chars-min"
```

### 多用户会话隔离 (必须)
```json5
{
  "session": {
    "dmScope": "per-channel-peer"  // 每个用户独立会话
  }
}
```

### Gateway 认证 (必须)
```json5
{
  "gateway": {
    "bind": "lan",  // 或 "127.0.0.1" 用于本地
    "auth": {
      "mode": "token",
      "token": "${CLAWDBOT_GATEWAY_TOKEN}"
    }
  }
}
```

---

## 📊 规模指南

| 用户数 | 配置 |
|--------|------|
| < 20 | 单服务器, 4核/8GB RAM |
| 20-50 | 单服务器, 8核/16GB RAM |
| 50-200 | 负载均衡 + 2个实例 |
| 200+ | 集群 + Redis 共享会话 |

---

## 🛡️ 安全检查 (部署前)

```bash
# 运行安全审计
moltbot security audit --deep

# 检查文件权限
ls -la /etc/moltbot/
# 应该是: -rw-r-----  (640)

# 检查服务用户
ps aux | grep moltbot
# 应该运行在 moltbot 用户下，非 root
```

---

## 📋 日常运维命令

```bash
# 查看服务状态
systemctl status moltbot-gateway.service

# 查看实时日志
journalctl -u moltbot-gateway.service -f

# 重启服务
systemctl restart moltbot-gateway.service

# 查看模型状态
moltbot models status

# 查看活跃会话
moltbot sessions list

# 安全审计
moltbot security audit
```

---

## 🔧 故障排查

### 服务无法启动
```bash
# 检查配置
moltbot doctor --fix

# 查看错误日志
journalctl -u moltbot-gateway.service -n 100 --no-pager
```

### 认证失败
```bash
# 检查 token
grep CLAWDBOT_GATEWAY_TOKEN /etc/moltbot/environment

# 检查日志
grep "unauthorized\|auth" /var/log/moltbot/gateway.log
```

### 性能问题
```bash
# 检查资源使用
top -p $(pgrep moltbot-gateway)

# 查看并发数
grep "maxConcurrent" /etc/moltbot/moltbot.json
```

---

## 📱 客户端连接

### Web UI
```
https://moltbot.company.com/?token=YOUR_GATEWAY_TOKEN
```

### WebSocket
```javascript
const ws = new WebSocket('wss://moltbot.company.com');
ws.send(JSON.stringify({
  type: 'auth',
  token: 'YOUR_GATEWAY_TOKEN'
}));
```

### HTTP API
```bash
curl -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  https://moltbot.company.com/v1/chat/completions
```

---

## 🔄 配置热更新

```bash
# 获取当前配置哈希
moltbot gateway call config.get --param '{}'

# 更新配置
moltbot gateway call config.patch --param '{
  "raw": "{ agents: { defaults: { maxConcurrent: 16 } } }",
  "baseHash": "<hash-from-get>"
}'
```

---

## 💰 成本控制

```bash
# 查看使用统计
moltbot models usage

# 设置每日限额
# 在配置文件中:
{
  "models": {
    "providers": {
      "anthropic": {
        "budget": {
          "daily": 100  // 美元
        }
      }
    }
  }
}
```

---

## 📞 获取帮助

- 📖 [完整文档](ENTERPRISE.md)
- 🔒 [安全清单](security-checklist.md)
- 🐛 [问题反馈](https://github.com/m1heng/moltbot/issues)
- 💬 [社区讨论](https://github.com/m1heng/moltbot/discussions)

---

## ⚠️ 重要提醒

1. **永远不要**将 API 密钥提交到版本控制
2. **定期轮换** Gateway token (建议每月)
3. **启用 HTTPS** 生产环境
4. **配置会话隔离** 多用户场景
5. **定期备份** 配置和会话数据
6. **监控资源** 内存和 CPU 使用
7. **更新软件** 保持最新版本
