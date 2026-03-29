# OpenClaw 故障排除指南

本文档帮助解决 OpenClaw 常见问题。

## 🚀 启动问题

### 无法启动 OpenClaw

**症状**: 运行 `openclaw start` 失败

**解决方案**:
1. 检查 Node.js 版本（需要 18+）:
   ```bash
   node --version
   ```

2. 重新安装:
   ```bash
   npm uninstall -g openclaw
   npm install -g openclaw
   ```

3. 检查端口占用:
   ```bash
   lsof -i :8080
   ```

### 连接 Gateway 失败

**症状**: 无法连接到 localhost:8080

**解决方案**:
1. 确认 Gateway 正在运行:
   ```bash
   openclaw status
   ```

2. 检查防火墙设置
3. 查看日志: `openclaw logs`

## 🤖 Agent 问题

### Agent 不响应

**可能原因**:
- 模型配置错误
- 网络问题
- API 配额用尽

**排查步骤**:
1. 检查模型可用性: `openclaw models list`
2. 查看 agent 日志
3. 尝试更换模型

### 消息发送失败

**错误信息**: `Too Many Requests`

**解决方案**:
- 等待后重试
- 配置限流策略
- 使用更快的模型

## 💬 频道问题

### Telegram Bot 无法连接

1. 检查 Bot Token 是否正确
2. 确认 Bot 已被正确配置
3. 查看 Telegram 日志

### Discord 频道无响应

1. 检查 Discord App 权限
2. 确认 Gateway Intents 配置
3. 验证机器人已加入服务器

## 🛠️ 技能问题

### 技能无法安装

**解决方案**:
1. 检查技能依赖
2. 确认网络连接
3. 查看错误日志

### 自定义技能不工作

确保技能目录结构正确:
```
~/.openclaw/skills/
└── my-skill/
    ├── SKILL.md
    └── src/
        └── index.ts
```

## 📊 性能问题

### 内存占用过高

**解决方案**:
1. 减少并发会话数
2. 清理旧会话
3. 重启 Gateway

### 响应速度慢

1. 使用更快的模型
2. 检查网络延迟
3. 优化系统提示词

## 🔧 诊断命令

```bash
# 查看状态
openclaw status

# 检查配置
openclaw doctor

# 查看日志
openclaw logs

# 重置配置
openclaw reset --force
```

---

如问题仍未解决，请提交 Issue。
