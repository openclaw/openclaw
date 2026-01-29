# Moltbot 安全检查清单

## 部署前安全检查

### ✅ 基础配置

- [ ] 使用专用系统用户运行 Moltbot (非 root)
- [ ] 配置文件权限设置为 640 或更严格
- [ ] 会话目录权限设置为 700
- [ ] API 密钥使用环境变量存储，不硬编码
- [ ] Gateway token 长度至少 32 字符
- [ ] 启用 Gateway 认证 (token 或 password)
- [ ] 配置会话隔离 (`session.dmScope: per-channel-peer`)

### ✅ 网络安全

- [ ] 使用 HTTPS (SSL/TLS)
- [ ] 配置防火墙规则，限制访问来源
- [ ] 配置反向代理 (Nginx/Caddy)
- [ ] 设置 `trustedProxies` (如果使用反向代理)
- [ ] 禁用公网绑定 (bind: loopback 或配置防火墙)

### ✅ 访问控制

- [ ] 配置用户白名单/配对机制
- [ ] 限制可执行命令的用户组
- [ ] 禁用不必要的工具/功能
- [ ] 配置沙箱模式 (如果需要文件/Shell 访问)

### ✅ 日志和监控

- [ ] 启用敏感信息脱敏 (`redactSensitive: tools`)
- [ ] 配置日志轮转
- [ ] 设置日志监控和告警
- [ ] 定期运行安全审计 (`moltbot security audit`)

### ✅ 数据保护

- [ ] 定期备份配置和会话数据
- [ ] 加密备份文件
- [ ] 限制备份文件访问权限
- [ ] 制定数据保留策略

### ✅ 证书和密钥

- [ ] 使用 Let's Encrypt 或其他可信 CA 证书
- [ ] 配置自动证书续期
- [ ] 定期轮换 API 密钥和 token
- [ ] 使用强密码策略

### ✅ 更新和维护

- [ ] 定期更新 Moltbot 到最新版本
- [ ] 定期更新依赖包
- [ ] 订阅安全公告
- [ ] 制定应急响应计划

---

## 运行时安全检查

### 每日检查

```bash
# 1. 服务状态
systemctl status moltbot-gateway.service

# 2. 错误日志
journalctl -u moltbot-gateway.service --since "1 day ago" | grep -i error

# 3. 异常访问
grep -i "unauthorized\|forbidden" /var/log/moltbot/gateway.log

# 4. 资源使用
ps aux | grep moltbot-gateway
```

### 每周检查

```bash
# 1. 完整安全审计
moltbot security audit --deep

# 2. 磁盘使用
du -sh /var/lib/moltbot

# 3. 日志大小
du -sh /var/log/moltbot

# 4. 证书有效期
openssl x509 -in /etc/letsencrypt/live/moltbot.company.com/cert.pem -noout -dates
```

### 每月检查

```bash
# 1. 备份验证
test -f /backup/moltbot/$(date +%Y%m%d)/moltbot.json

# 2. API 使用统计
moltbot models usage

# 3. 性能分析
moltbot health

# 4. 密钥轮换检查
# 检查密钥是否超过 90 天未更换
```

---

## 安全事件响应

### 检测到异常访问

1. **立即行动**
   ```bash
   # 停止服务
   systemctl stop moltbot-gateway.service

   # 检查日志
   journalctl -u moltbot-gateway.service -n 1000 > /tmp/security-incident.log

   # 保存会话数据作为证据
   cp -r /var/lib/moltbot/sessions /tmp/evidence/
   ```

2. **调查分析**
   - 检查访问日志中的异常 IP
   - 检查执行的命令
   - 检查文件访问记录

3. **恢复服务**
   - 轮换所有密钥和 token
   - 审查访问控制配置
   - 更新防火墙规则
   - 从备份恢复配置

4. **加固措施**
   - 限制访问来源
   - 启用更严格的认证
   - 增加监控频率
   - 通知相关用户

### API 密钥泄露

1. **立即撤销泄露的密钥**
2. **生成新的 API 密钥**
3. **更新环境变量**
4. **重启服务**
5. **检查使用记录，确认损失范围**

---

## 合规性检查

### GDPR (欧盟)

- [ ] 用户有权查看和删除其数据
- [ ] 会话数据加密存储
- [ ] 数据处理记录
- [ ] 隐私政策告知用户数据使用

### SOC 2

- [ ] 访问控制文档化
- [ ] 变更管理流程
- [ ] 事件响应程序
- [ ] 定期安全审计

### ISO 27001

- [ ] 信息安全策略
- [ ] 资产管理
- [ ] 访问控制
- [ ] 密码学控制
- [ ] 操作安全

---

## 安全配置示例

### 最小权限配置

```json5
{
  "gateway": {
    "bind": "127.0.0.1",  // 仅本地
    "auth": {
      "mode": "token",
      "token": "${CLAWDBOT_GATEWAY_TOKEN}"
    }
  },
  "session": {
    "dmScope": "per-channel-peer"
  },
  "commands": {
    "useAccessGroups": ["operators"]
  },
  "logging": {
    "redactSensitive": "tools"
  }
}
```

### 企业级配置

```json5
{
  "gateway": {
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "${CLAWDBOT_GATEWAY_TOKEN}"
    },
    "trustedProxies": ["10.0.0.0/8"]
  },
  "session": {
    "dmScope": "per-channel-peer",
    "reset": {
      "mode": "idle",
      "idleMinutes": 60
    }
  },
  "agents": {
    "defaults": {
      "maxConcurrent": 8,
      "sandbox": {
        "mode": "docker"  // 沙箱隔离
      }
    }
  }
}
```

---

## 联系和支持

- 官方文档: https://docs.molt.bot
- 安全问题: security@molt.bot
- GitHub Issues: https://github.com/m1heng/moltbot/issues
